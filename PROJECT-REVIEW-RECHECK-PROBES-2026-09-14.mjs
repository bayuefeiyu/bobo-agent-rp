import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, cp, rm } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { RpWorkflowEngine } from './.agents/skills/st-card-to-pi-rp/assets/pi-rp-runtime/.pi/lib/rp-workflow-engine.mjs';
import { normalizeWorkflowDefinition, resolveInstanceKey, resolveCodeNodeRoute } from './.agents/skills/st-card-to-pi-rp/assets/pi-rp-runtime/.pi/lib/rp-workflows.mjs';
import { RpDataStore } from './.agents/skills/st-card-to-pi-rp/assets/pi-rp-runtime/.pi/lib/rp-data-store.mjs';
import { executeDataBatchOrThrow } from './.agents/skills/st-card-to-pi-rp/assets/pi-rp-runtime/.pi/lib/rp-data-changes.mjs';
import { queryData, getDataRecord } from './.agents/skills/st-card-to-pi-rp/assets/pi-rp-runtime/.pi/lib/rp-data-query.mjs';
import { createComfyUiService } from './.agents/skills/st-card-to-pi-rp/assets/pi-rp-runtime/.pi/lib/rp-comfyui.mjs';
import { registerNodeArtifacts, cleanupArtifacts, workflowNodeWorkspace } from './.agents/skills/st-card-to-pi-rp/assets/pi-rp-runtime/.pi/lib/rp-data-artifacts.mjs';
import { freezeTriggeredDocuments, stageTriggeredDocuments } from './.agents/skills/st-card-to-pi-rp/assets/pi-rp-runtime/.pi/lib/rp-workspace-snapshot.mjs';
import { buildImageOperation, ensureImageOperation, executeImageOperation } from './global-modules/comfy-image-generation/runtime/image-execution.mjs';
import { execute as resolveImageInput } from './global-modules/comfy-image-generation/runtime/workflow/resolve-input.mjs';
import { execute as persistImage } from './global-modules/comfy-image-generation/runtime/workflow/persist-and-render.mjs';

const root = process.cwd();
const temporary = await mkdtemp(resolve(tmpdir(), 'rp-acceptance-recheck-'));
const load = async path => JSON.parse(await readFile(resolve(root, path), 'utf8'));
const observations = {};
const profile = { id: 'demo', revision: '1', guideId: 'demo', digest: 'digest', workflowDigest: 'workflow', connectionId: 'local', connectionBaseUrl: 'http://127.0.0.1:8188', output: { nodeIds: ['2'] }, guide: 'Write the scene.' };
const simpleComfy = { profiles: async () => [profile], assemblePrompt: (_, content) => ({ positive: content, negative: '' }), chatFolder: () => 'chat' };
const top = await load('.agents/skills/st-card-to-pi-rp/assets/pi-rp-runtime/workflows/agent-image-generation/workflow.json');
const internal = await load('global-modules/comfy-image-generation/workflows/agent-image-generation/workflow.json');

// Real definitions, public instance-key calculation, and real active-start behavior.
observations.internalKeys = {
  mode: normalizeWorkflowDefinition(internal).instancePolicy.mode,
  a: resolveInstanceKey(internal, { request: { operationId: 'a' } }),
  b: resolveInstanceKey(internal, { request: { operationId: 'b' } }),
};
let release;
const gate = new Promise(done => { release = done; });
const activeEngine = new RpWorkflowEngine({ executor: async () => { await gate; return { output: {} }; } });
const firstRun = await activeEngine.start(top, { id: 'first', payload: { operationId: 'same', customBrief: 'alpha' } });
const reused = await activeEngine.start(top, { id: 'second', payload: { operationId: 'same', customBrief: 'alpha' }, reuseActive: true });
let activeConflict = null;
try { await activeEngine.start(top, { id: 'third', payload: { operationId: 'same', customBrief: 'beta' }, reuseActive: true }); }
catch (error) { activeConflict = { code: error.code, status: error.status }; }
observations.activeConflict = { original: firstRun.id, returned: reused.id, sameInputReused: firstRun.id === reused.id, differentInput: activeConflict };
release(); await activeEngine.wait(firstRun.id);

const moduleDirectory = resolve(root, 'global-modules/comfy-image-generation');
const store = new RpDataStore({ sessionDirectory: resolve(temporary, 'data'), modules: [{ contract: await load('global-modules/comfy-image-generation/data-contract.json'), moduleDirectory }] });
await store.initialize();
const access = [
  { moduleId: 'comfy-image-generation', collectionId: 'requests', capabilities: ['image.requests.prepare'], views: ['maintenance'] },
  { moduleId: 'comfy-image-generation', collectionId: 'renders', capabilities: ['image.renders.execute'], views: ['maintenance'] },
  { moduleId: 'comfy-image-generation', collectionId: 'settings', capabilities: ['image.preferences.read'], views: ['rp'] },
];
const data = {
  query: request => { const grant = access.find(item => item.collectionId === request.collectionId); return queryData(store, request, { ...grant, runtimeLimit: 20, nodeLimit: 20, runtimeCharacters: 50000, nodeCharacters: 50000 }); },
  get: request => getDataRecord(store, request, access.find(item => item.collectionId === request.collectionId)),
  submit: draft => executeDataBatchOrThrow(store, draft, { access, context: { binding: { turn: 1, messageId: null } } }),
};
let posts = 0;
const engine = new RpWorkflowEngine({
  resolveWorkflow: async () => internal,
  executor: async ({ workflow, run, node, invokeWorkflow }) => {
    if (node.type === 'call') return { output: await invokeWorkflow({ workflow: node.target, arguments: { request: run.payload }, documents: {}, outputPaths: {} }) };
    if (node.type === 'workflow-return') return { output: { outputs: {} } };
    if (node.type === 'agent') return { output: { prompts: [{ guideId: 'demo', content: 'harbor' }] } };
    const workspace = workflowNodeWorkspace(resolve(temporary, 'data'), workflow.id, run.id, node.id);
    await mkdir(workspace, { recursive: true });
    const constrained = { ...data, submit: draft => {
      const injected = structuredClone(draft);
      for (const op of injected.operations) if (op.action === 'transition' && op.params.state === 'submitting') op.expectedRevision = 999;
      return data.submit(injected);
    } };
    const services = { comfy: { ...simpleComfy, generate: async () => { posts++; throw new Error('Must not submit'); } } };
    const output = await (node.id === 'resolve-input' ? resolveImageInput : persistImage)({ workflow, run, node, workspace, data: constrained, services, conversation: { messages: [], player: {} } });
    return { output, route: resolveCodeNodeRoute(node, output) };
  },
  beforeNodeComplete: async ({ workflow, run, node, result }) => {
    await registerNodeArtifacts({ sessionDirectory: resolve(temporary, 'data'), workflow, run, node });
    return result;
  },
});
const started = await engine.start(top, { id: 'receipt-failure', cardId: 'card', chatId: 'chat', turn: 1, trigger: { type: 'manual' }, payload: { operationId: 'receipt-failure', profileIds: ['demo'], inputPolicy: { kind: 'custom-brief' }, customBrief: 'harbor' } });
const completed = await engine.wait(started.id);
const child = [...engine.runs.values()].find(entry => entry.workflow.kind === 'module-internal');
observations.failedCommit = { parentStatus: completed.status, childStatus: child.run.status, outcome: child.run.nodes['persist-and-render'].output, posts };

const base = { operationId: 'prompt-reuse', ordinal: 2, source: { sourceKind: 'custom-brief', triggerKind: 'manual', imageTarget: 'harbor', userDirection: '', referenceContext: '' }, profiles: [profile], contentPrompts: [{ guideId: 'demo', content: 'first prompt' }], chatFolder: 'chat', services: { comfy: simpleComfy } };
const definition = buildImageOperation(base);
await ensureImageOperation({ data, definition });
const changed = buildImageOperation({ ...base, contentPrompts: [{ guideId: 'demo', content: 'different edited prompt' }] });
const replay = await ensureImageOperation({ data, definition: changed });
observations.promptConflict = { sameFingerprint: definition.requestData.inputFingerprint === changed.requestData.inputFingerprint, returnedPrompt: replay.request.value['请求'].contentPrompts[0].content };
const resolvingRun = { id: 'replay-profile', arguments: { request: { operationId: 'prompt-reuse', profileIds: ['demo'], inputPolicy: { kind: 'custom-brief' }, customBrief: 'harbor' } }, trigger: { type: 'manual' }, cardId: 'card', chatId: 'chat', nodes: {} };
try {
  const replayOutput = await resolveImageInput({ run: resolvingRun, conversation: { messages: [], player: { name: 'changed player' } }, data, services: { comfy: { ...simpleComfy, profiles: async () => { throw new Error('profiles must not be loaded during replay'); } } }, workspace: resolve(temporary, 'profile-replay') });
  observations.profileReplay = { succeeded: true, requestId: replayOutput.requestId, route: replayOutput.route };
} catch (error) { observations.profileReplay = { succeeded: false, code: error.code, message: error.message }; }

// A real HTTP service and real profile override: inspect persisted versus queued prompt.
let queued;
let replyWithGatewayFailure = false;
let acceptedPosts = 0;
const server = createServer(async (request, response) => {
  if (request.url === '/prompt') { const chunks = []; for await (const chunk of request) chunks.push(chunk); queued = JSON.parse(Buffer.concat(chunks)); acceptedPosts++; response.setHeader('content-type', 'application/json'); if (replyWithGatewayFailure) { response.statusCode = 502; response.end(JSON.stringify({ error: 'Gateway lost the upstream response' })); return; } response.end(JSON.stringify({ prompt_id: queued.prompt_id })); return; }
  if (request.url.startsWith('/history/')) { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ [queued.prompt_id]: { status: { status_str: 'success' }, outputs: { '2': { images: [{ filename: 'result.png', subfolder: '', type: 'output' }] } } } })); return; }
  response.statusCode = 404; response.end();
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const serviceRoot = resolve(temporary, 'comfy');
const serviceModule = resolve(serviceRoot, 'card/features/comfy-image-generation');
const profileDirectory = resolve(serviceModule, 'profiles/demo');
await mkdir(profileDirectory, { recursive: true });
await mkdir(resolve(serviceModule, 'skill/guides/demo'), { recursive: true });
await writeFile(resolve(profileDirectory, 'workflow.api.json'), JSON.stringify({ '1': { inputs: { text: '' }, class_type: 'CLIPTextEncode' }, '2': { inputs: { filename_prefix: '' }, class_type: 'SaveImage' } }));
await writeFile(resolve(profileDirectory, 'profile.json'), JSON.stringify({ schemaVersion: 1, id: 'demo', title: 'Demo', revision: '1', guideId: 'demo', connectionId: 'local', workflowFile: 'workflow.api.json', bindings: { positive: [{ nodeId: '1', input: 'text' }], negative: [], seed: [], filenamePrefix: [{ nodeId: '2', input: 'filename_prefix' }] }, prompt: { separator: ', ', positivePrefix: 'old style', positiveSuffix: '', negative: '' }, output: { nodeIds: ['2'] } }));
await writeFile(resolve(serviceModule, 'skill/guides/demo/SKILL.md'), 'Guide');
const comfy = createComfyUiService({ rootDirectory: serviceRoot, cardDirectory: resolve(serviceRoot, 'card'), featureModules: [{ id: 'comfy-image-generation', moduleDirectory: serviceModule }], secretCacheDirectory: resolve(serviceRoot, 'secrets') });
await comfy.saveConnection({ id: 'local', baseUrl: `http://127.0.0.1:${server.address().port}` });
try {
  const before = (await comfy.profiles())[0];
  const frozen = buildImageOperation({ ...base, operationId: 'override-race', profiles: [before], services: { comfy } });
  const ensured = await ensureImageOperation({ data, definition: frozen });
  await comfy.saveProfileOverride('demo', { positivePrefix: 'new style' });
  const result = await executeImageOperation({ data, services: { comfy }, requestId: frozen.requestId, renders: ensured.renders });
  const afterOverride = (await comfy.profiles())[0];
  observations.profileOverride = { state: result.outcomes[0].state, storedPositivePrompt: frozen.renders[0].data.positivePrompt, queuedPositivePrompt: queued.prompt['1'].inputs.text, effectiveDigestChanged: before.effectiveDigest !== afterOverride.effectiveDigest };
  const gatewayDefinition = buildImageOperation({ ...base, operationId: 'gateway-uncertain', profiles: await comfy.profiles(), services: { comfy } });
  const gatewayEnsured = await ensureImageOperation({ data, definition: gatewayDefinition });
  const postsBefore = acceptedPosts;
  replyWithGatewayFailure = true;
  const gatewayFirst = await executeImageOperation({ data, services: { comfy }, requestId: gatewayDefinition.requestId, renders: gatewayEnsured.renders });
  const acceptedId = queued.prompt_id;
  replyWithGatewayFailure = false;
  const gatewayReplay = await executeImageOperation({ data, services: { comfy }, requestId: gatewayDefinition.requestId, renders: gatewayEnsured.renders });
  observations.gatewayFailure = { firstState: gatewayFirst.outcomes[0].state, retryState: gatewayReplay.outcomes[0].state, acceptedPosts: acceptedPosts - postsBefore, changedPromptId: acceptedId !== queued.prompt_id };
} finally { server.closeAllConnections(); server.close(); await once(server, 'close'); }

// Use the actual source output retention and the real next-turn cleanup.
const sourceWorkflow = normalizeWorkflowDefinition(await load('global-modules/world-narrative-coordinator/integration/workflows/director-post-turn/workflow.json'));
const sourceNode = sourceWorkflow.nodes.find(node => node.id === 'review');
const sourceRun = { id: 'source', turn: 3, nodes: {} };
const sourceDirectory = workflowNodeWorkspace(temporary, sourceWorkflow.id, sourceRun.id, sourceNode.id);
await mkdir(resolve(sourceDirectory, 'trigger/turn-context'), { recursive: true });
await writeFile(resolve(sourceDirectory, 'trigger/turn-context/DOCUMENTS.md'), '# Frozen input');
await registerNodeArtifacts({ sessionDirectory: temporary, workflow: sourceWorkflow, run: sourceRun, node: sourceNode });
const relativePath = `workspace/private/${sourceWorkflow.id}/${sourceRun.id}/${sourceNode.id}/trigger/turn-context`;
const delayedDefinition = await load('global-modules/world-narrative-coordinator/integration/workflows/director-deep-wrapper/workflow.json');
const delayedTriggerDocuments = await freezeTriggeredDocuments({ sessionDirectory: temporary, workflow: delayedDefinition, runId: 'delayed', triggerDocuments: { 'story-context': { path: relativePath, format: 'document-workspace-snapshot', kind: 'directory' } } });
let releaseBlocker, signalBlocker;
const blockerGate = new Promise(done => { releaseBlocker = done; });
const blockerStarted = new Promise(done => { signalBlocker = done; });
const delayedEngine = new RpWorkflowEngine({ policy: { maxConcurrency: 2 }, executor: async ({ workflow, run, node }) => {
  if (workflow.id === 'blocker') { signalBlocker(); await blockerGate; return { output: {} }; }
  await stageTriggeredDocuments({ sessionDirectory: temporary, workflow, run, node });
  return { output: {} };
} });
await delayedEngine.start({ schemaVersion: 3, id: 'blocker', kind: 'global-background', nodes: [{ id: 'hold', type: 'code' }] });
await blockerStarted;
const delayedRun = await delayedEngine.start(delayedDefinition, { id: 'delayed', turn: 3, payload: { triggerDocuments: delayedTriggerDocuments } });
await cleanupArtifacts(temporary, { type: 'turn', turn: 4 });
releaseBlocker();
const delayedResult = await delayedEngine.wait(delayedRun.id);
observations.delayedSnapshot = { status: delayedResult.status, error: delayedResult.nodes['start-if-needed'].error };

// Staged release inspection in a disposable repository, never in the user's index.
const releaseRoot = resolve(temporary, 'release');
await mkdir(releaseRoot);
for (const path of ['global-modules', '.agents/skills/create-pi-rp-feature-module/assets', '.agents/skills/create-pi-rp-feature-module/scripts', '.agents/skills/st-card-to-pi-rp/assets/pi-rp-runtime/.pi/lib', '.agents/skills/st-card-to-pi-rp/scripts/check_release_manifest.mjs', 'PROJECT-RELEASE-MANIFEST.json', 'README.md', 'PROJECT_STATUS.md', '.gitignore']) {
  await mkdir(dirname(resolve(releaseRoot, path)), { recursive: true });
  await cp(resolve(root, path), resolve(releaseRoot, path), { recursive: true });
}
const git = args => { const result = spawnSync('git', args, { cwd: releaseRoot, encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr); };
git(['init', '-q']);
const schemaPath = 'global-modules/local-scene-narrative/schemas/story.schema.json';
const schema = await readFile(resolve(releaseRoot, schemaPath));
await writeFile(resolve(releaseRoot, schemaPath), '{"broken":true}');
git(['add', '-A']);
await writeFile(resolve(releaseRoot, schemaPath), schema);
const checker = '.agents/skills/st-card-to-pi-rp/scripts/check_release_manifest.mjs';
const checked = spawnSync(process.execPath, [checker, '--staged'], { cwd: releaseRoot, encoding: 'utf8' });
observations.stagedRelease = { exitCode: checked.status, output: checked.stdout.trim(), error: checked.stderr.trim(), stagedSchema: spawnSync('git', ['show', `:${schemaPath}`], { cwd: releaseRoot, encoding: 'utf8' }).stdout };

assert.notEqual(observations.internalKeys.a, observations.internalKeys.b);
assert.equal(observations.activeConflict.sameInputReused, true);
assert.deepEqual(observations.activeConflict.differentInput, { code: 'workflow_instance_conflict', status: 409 });
assert.deepEqual({ parent: observations.failedCommit.parentStatus, child: observations.failedCommit.childStatus, posts: observations.failedCommit.posts }, { parent: 'failed', child: 'failed', posts: 0 });
assert.equal(observations.promptConflict.sameFingerprint, true);
assert.equal(observations.promptConflict.returnedPrompt, 'first prompt');
assert.equal(observations.profileReplay.succeeded, true);
assert.deepEqual({ stored: observations.profileOverride.storedPositivePrompt, queued: observations.profileOverride.queuedPositivePrompt, changed: observations.profileOverride.effectiveDigestChanged }, { stored: 'old style, first prompt', queued: 'old style, first prompt', changed: true });
assert.deepEqual({ first: observations.gatewayFailure.firstState, recovered: observations.gatewayFailure.retryState, posts: observations.gatewayFailure.acceptedPosts, changedPromptId: observations.gatewayFailure.changedPromptId }, { first: 'submitting', recovered: 'completed', posts: 1, changedPromptId: false });
assert.equal(observations.delayedSnapshot.status, 'completed');
assert.notEqual(observations.stagedRelease.exitCode, 0);
assert.equal(observations.stagedRelease.stagedSchema, '{"broken":true}');
await rm(temporary, { recursive: true, force: true });
observations.temporaryCleaned = true;

console.log(JSON.stringify({ temporary, observations }, null, 2));
