const inlineRules = [
  { kind: "code", pattern: /`([^`\n]+)`/g },
  { kind: "strong", pattern: /\*\*([^*\n]+)\*\*|__([^_\n]+)__/g },
  { kind: "delete", pattern: /~~([^~\n]+)~~/g },
  { kind: "emphasis", pattern: /\*([^*\n]+)\*|_([^_\n]+)_/g },
  { kind: "link", pattern: /\[([^\]\n]+)]\((https?:\/\/[^\s)]+)\)/g },
];

function appendPlainText(parent, text) {
  if (!text) return;
  parent.append(document.createTextNode(text.replace(/\\([\\`*_[\]()#+.!~-])/g, "$1")));
}

function nextInlineToken(text, offset) {
  let selected = null;
  for (const rule of inlineRules) {
    rule.pattern.lastIndex = offset;
    let match = rule.pattern.exec(text);
    while (match && match.index > 0 && text[match.index - 1] === "\\") {
      rule.pattern.lastIndex = match.index + 1;
      match = rule.pattern.exec(text);
    }
    if (match && (!selected || match.index < selected.match.index)) selected = { rule, match };
  }
  return selected;
}

function appendInline(parent, text) {
  let offset = 0;
  while (offset < text.length) {
    const token = nextInlineToken(text, offset);
    if (!token) {
      appendPlainText(parent, text.slice(offset));
      break;
    }
    appendPlainText(parent, text.slice(offset, token.match.index));
    const { kind } = token.rule;
    const match = token.match;
    const inner = match[1] || match[2] || "";
    let element;
    if (kind === "code") element = document.createElement("code");
    if (kind === "strong") element = document.createElement("strong");
    if (kind === "delete") element = document.createElement("del");
    if (kind === "emphasis") element = document.createElement("em");
    if (kind === "link") {
      element = document.createElement("a");
      element.href = match[2];
      element.target = "_blank";
      element.rel = "noopener noreferrer";
    }
    element.textContent = inner;
    parent.append(element);
    offset = match.index + match[0].length;
  }
}

function appendInlineLines(parent, lines) {
  lines.forEach((line, index) => {
    if (index > 0) parent.append(document.createElement("br"));
    appendInline(parent, line);
  });
}

function headingMatch(line) {
  return line.match(/^(#{1,6})[ \t]*(\S.*)$/);
}

function listMatch(line) {
  const unordered = line.match(/^\s*[-+*]\s+(.+)$/);
  if (unordered) return { ordered: false, content: unordered[1] };
  const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
  return ordered ? { ordered: true, content: ordered[1] } : null;
}

function startsBlock(line) {
  return Boolean(
    headingMatch(line)
    || listMatch(line)
    || /^\s*>/.test(line)
    || /^\s*```/.test(line)
    || /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line),
  );
}

export function renderMarkdown(container, source) {
  const lines = String(source ?? "").replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n");
  const fragment = document.createDocumentFragment();
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }

    if (/^\s*```/.test(line)) {
      const language = line.trim().slice(3).trim();
      const codeLines = [];
      index += 1;
      while (index < lines.length && !/^\s*```\s*$/.test(lines[index])) {
        codeLines.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      const pre = document.createElement("pre");
      const code = document.createElement("code");
      if (language) code.dataset.language = language;
      code.textContent = codeLines.join("\n");
      pre.append(code);
      fragment.append(pre);
      continue;
    }

    const heading = headingMatch(line);
    if (heading) {
      const element = document.createElement(`h${heading[1].length}`);
      appendInline(element, heading[2]);
      fragment.append(element);
      index += 1;
      continue;
    }

    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      fragment.append(document.createElement("hr"));
      index += 1;
      continue;
    }

    if (/^\s*>/.test(line)) {
      const quoteLines = [];
      while (index < lines.length && /^\s*>/.test(lines[index])) {
        quoteLines.push(lines[index].replace(/^\s*>\s?/, ""));
        index += 1;
      }
      const quote = document.createElement("blockquote");
      appendInlineLines(quote, quoteLines);
      fragment.append(quote);
      continue;
    }

    const firstListItem = listMatch(line);
    if (firstListItem) {
      const list = document.createElement(firstListItem.ordered ? "ol" : "ul");
      while (index < lines.length) {
        const item = listMatch(lines[index]);
        if (!item || item.ordered !== firstListItem.ordered) break;
        const listItem = document.createElement("li");
        appendInline(listItem, item.content);
        list.append(listItem);
        index += 1;
      }
      fragment.append(list);
      continue;
    }

    const paragraphLines = [line];
    index += 1;
    while (index < lines.length && lines[index].trim() && !startsBlock(lines[index])) {
      paragraphLines.push(lines[index]);
      index += 1;
    }
    const paragraph = document.createElement("p");
    appendInlineLines(paragraph, paragraphLines);
    fragment.append(paragraph);
  }

  container.replaceChildren(fragment);
}
