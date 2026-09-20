import assert from "node:assert/strict";
import test from "node:test";
import { renderCardText, renderCardTextValues, renderTeamAuthorText } from "./rp-card-text.mjs";

test("author templates bind the literal player name once", () => {
  const name = '林$&\\"{{user}}🙂';
  assert.equal(renderCardText("见到{{user}}。", name), `见到${name}。`);
  assert.deepEqual(renderCardTextValues({ title: "{{user}}的故事", nested: ["{{user}}"] }, name), { title: `${name}的故事`, nested: [name] });
});

test("unresolved character and legacy user macros fail with their source", () => {
  for (const macro of ["{{char}}", "<char>", "<bot>", "<user>"]) {
    assert.throws(() => renderCardText(macro, "林舟", "openings/00.md"), /openings\/00\.md contains/);
  }
  assert.throws(() => renderCardTextValues({ "{{user}}": "text" }, "林舟"), /structural key/);
});

test("team member and assistant author prompts use the same session name", () => {
  const member = id => ({ id, focus: "围绕{{user}}", prompt: "写给{{user}}" });
  const original = { leader: member("leader"), secretary: member("secretary"), experts: [member("expert")], members: [member("leader")], assistants: [{ id: "helper", prompt: "帮助{{user}}" }], baseRetrieval: { id: "reader", prompt: "检索{{user}}" } };
  const rendered = renderTeamAuthorText(original, "阿岚");
  for (const item of [rendered.leader, rendered.secretary, ...rendered.experts, ...rendered.members]) {
    assert.equal(item.focus, "围绕阿岚");
    assert.equal(item.prompt, "写给阿岚");
  }
  assert.equal(rendered.assistants[0].prompt, "帮助阿岚");
  assert.equal(rendered.baseRetrieval.prompt, "检索阿岚");
  assert.equal(original.leader.prompt, "写给{{user}}");
});
