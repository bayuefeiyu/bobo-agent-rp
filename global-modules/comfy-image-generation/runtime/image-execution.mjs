import { createHash } from "node:crypto";
import { access } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * The seed contract lives beside the Web bridge that freezes and submits the same profiles, so the
 * derivation cannot drift between the two copies. Its location differs between the repository source
 * tree (`global-modules/<module>/runtime/`), an installed card (`<play>/cards/<card>/features/<module>/
 * runtime/` with `<play>/.pi/lib` beside `cards/`), and the skill asset tree, so the search walks up
 * from this module copy instead of hardcoding one depth per layout. A hardcoded depth silently missed
 * the installed card, and every in-card generation failed with a 500 before it reached ComfyUI.
 */
async function loadSeedContract() {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [];
  let directory = here;
  for (let depth = 0; depth < 6; depth += 1) {
    candidates.push(resolve(directory, ".pi", "lib", "rp-comfyui-seed.mjs"));
    candidates.push(resolve(directory, ".agents", "skills", "st-card-to-pi-rp", "assets", "pi-rp-runtime", ".pi", "lib", "rp-comfyui-seed.mjs"));
    directory = resolve(directory, "..");
  }
  for (const candidate of candidates) {
    if (await access(candidate).then(() => true, () => false)) return import(pathToFileURL(candidate).href);
  }
  throw new Error(`The ComfyUI seed contract (rp-comfyui-seed.mjs) is not reachable from this module copy (${here}).`);
}

const { deriveSeed, effectiveSeedRange } = await loadSeedContract();

const MODULE_ID = "comfy-image-generation";
const CONFIRMED_FAILURES = new Set(["comfy_execution_failed", "comfy_queue_rejected", "comfy_output_missing", "comfy_pre_submit_failure"]);

const batch = (id, operations) => ({ protocolVersion: 1, batchId: id, status: "pending", commitPolicy: "atomic", operations });
const operation = (id, collectionId, recordType, action, extra) => ({ operationId: id, moduleId: MODULE_ID, collectionId, recordType, action, ...extra });
const requestValue = record => record?.value?.["请求"] || record?.data || null;
const renderValue = record => record?.value?.["生成记录"] || record?.data || null;

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}

function fingerprint(value) {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

function normalizeString(value) {
  return typeof value === "string" ? value.replaceAll("\r\n", "\n").trim() : "";
}

function normalizeInputPolicy(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const kind = ["recent-turns", "selected-messages", "workflow-output", "custom-brief"].includes(value.kind) ? value.kind : "recent-turns";
  if (kind !== "recent-turns" && kind !== "selected-messages") return { kind };
  return {
    kind,
    turnCount: Math.max(1, Math.min(20, Number.isSafeInteger(value.turnCount) ? value.turnCount : 3)),
    target: value.target === "all" ? "all" : "latest",
  };
}

function normalizeEditedPrompts(value) {
  if (!Array.isArray(value)) return [];
  return value.map(item => ({ guideId: normalizeString(item?.guideId), content: normalizeString(item?.content) }))
    .filter(item => item.guideId && item.content)
    .sort((left, right) => left.guideId.localeCompare(right.guideId));
}

export function normalizeImageOperationIntent(value = {}) {
  const profileIds = [];
  for (const id of Array.isArray(value.profileIds) ? value.profileIds : []) {
    const clean = normalizeString(id);
    if (clean && !profileIds.includes(clean)) profileIds.push(clean);
  }
  const messageIds = [...new Set((Array.isArray(value.messageIds) ? value.messageIds : []).map(normalizeString).filter(Boolean))].sort();
  const derived = value.derivedFrom && typeof value.derivedFrom === "object" && !Array.isArray(value.derivedFrom)
    ? canonical(value.derivedFrom)
    : value.derivedFrom
      ? { sourceRequestId: normalizeString(value.derivedFrom) }
      : null;
  return {
    operationId: normalizeString(value.operationId),
    profileIds,
    inputPolicy: normalizeInputPolicy(value.inputPolicy),
    customBrief: normalizeString(value.customBrief),
    workflowOutput: normalizeString(value.workflowOutput),
    messageIds,
    userDirection: normalizeString(value.userDirection),
    derivedFrom: derived,
    editedContentPrompts: normalizeEditedPrompts(value.editedContentPrompts || value.contentPrompts),
  };
}

export function imageOperationIntentFingerprint(value) {
  return fingerprint(normalizeImageOperationIntent(value));
}

export function assertImageOperationIntent(existing, intent, operationId = "") {
  const value = requestValue(existing);
  if (!value?.invocationFingerprint) {
    throw Object.assign(new Error(`Image operation ${operationId || existing?.id || "unknown"} predates invocation snapshots and cannot be recovered safely.`), { code: "image_recovery_unsupported" });
  }
  if (value.invocationFingerprint !== imageOperationIntentFingerprint(intent)) {
    throw conflict(`Image operation ${operationId || existing?.id || "unknown"} was reused with different invocation input.`);
  }
  if (!Array.isArray(value.effectiveProfileSnapshots) || !value.effectiveProfileSnapshots.length) {
    throw Object.assign(new Error(`Image operation ${operationId || existing?.id || "unknown"} has no frozen profile snapshot and cannot be recovered safely.`), { code: "image_recovery_unsupported" });
  }
  if (!value.continuityContext || typeof value.continuityContext !== "object") {
    throw Object.assign(new Error(`Image operation ${operationId || existing?.id || "unknown"} has no frozen continuity context and cannot be recovered safely.`), { code: "image_recovery_unsupported" });
  }
  return value;
}

function profileSnapshot(profile) {
  if (profile?.executionSnapshot) return structuredClone(profile.executionSnapshot);
  const snapshot = {
    schemaVersion: 1,
    id: profile.id,
    revision: String(profile.revision),
    guideId: profile.guideId,
    baseProfileDigest: profile.baseProfileDigest || profile.digest,
    overrideDigest: profile.overrideDigest || null,
    workflowDigest: profile.workflowDigest,
    guideDigest: profile.guideDigest || fingerprint(profile.guide || ""),
    connectionId: profile.connectionId,
    connectionBaseUrl: profile.connectionBaseUrl,
    workflow: structuredClone(profile.workflow || {}),
    bindings: structuredClone(profile.bindings || { positive: [], negative: [], seed: [], filenamePrefix: [] }),
    prompt: structuredClone(profile.prompt || { separator: ", ", positivePrefix: "", positiveSuffix: "", negative: "" }),
    guide: String(profile.guide || ""),
    outputNodeIds: [...(profile.output?.nodeIds || profile.outputNodeIds || [])],
    // The seed range is part of the frozen execution contract: it changes the seed this render
    // submits, so it has to be inside the digest rather than read live at submit time.
    seedRange: effectiveSeedRange(profile),
    seedRangeVerified: profile.seedRange !== undefined && profile.seedRange !== null,
  };
  snapshot.effectiveDigest = profile.effectiveDigest || fingerprint(snapshot);
  snapshot.snapshotId = `${snapshot.id}@${snapshot.effectiveDigest}`;
  return snapshot;
}

function profileBinding(profile) {
  const snapshot = profileSnapshot(profile);
  return {
    id: snapshot.id,
    revision: snapshot.revision,
    digest: snapshot.baseProfileDigest,
    effectiveDigest: snapshot.effectiveDigest,
    snapshotId: snapshot.snapshotId,
    guideId: snapshot.guideId,
    connectionId: snapshot.connectionId,
    connectionBaseUrl: snapshot.connectionBaseUrl,
    workflowDigest: snapshot.workflowDigest,
    outputNodeIds: [...snapshot.outputNodeIds],
  };
}

function resolvedInputFingerprint(source, snapshots, derivedFrom, continuityContext) {
  return fingerprint({
    sourceKind: source.sourceKind,
    triggerKind: source.triggerKind,
    referenceContext: source.referenceContext || "",
    imageTarget: source.imageTarget,
    userDirection: source.userDirection || "",
    selectedProfiles: snapshots.map(item => ({ id: item.id, snapshotId: item.snapshotId, effectiveDigest: item.effectiveDigest })),
    derivedFrom: derivedFrom || null,
    continuityContext,
  });
}

function conflict(message) {
  return Object.assign(new Error(message), { code: "image_operation_conflict", status: 409 });
}

async function submit(data, draft) {
  const receipt = await data.submit(draft);
  if (receipt?.status !== "committed") throw new Error(receipt?.error?.message || receipt?.error || `Image data batch ${draft.batchId} completed with status ${receipt?.status || "unknown"}.`);
  return receipt;
}

async function getRequest(data, id) {
  return data.get({ moduleId: MODULE_ID, collectionId: "requests", id, view: "maintenance" });
}

export async function getImageRequest(data, operationId) {
  const requestId = String(operationId || "").startsWith("image-request-") ? String(operationId) : `image-request-${operationId}`;
  return getRequest(data, requestId);
}

async function getRender(data, id) {
  return data.get({ moduleId: MODULE_ID, collectionId: "renders", id, view: "maintenance" });
}

async function findRenders(data, requestId) {
  const found = await data.query({ moduleId: MODULE_ID, collectionId: "renders", recordTypes: ["image.render"], where: { requestId: { eq: requestId } }, view: "maintenance", limit: 100 });
  return found.items || [];
}

async function transition(data, record, state, patch = {}) {
  const id = record.id;
  await submit(data, batch(`image-${state}-${id}-v${record.revision}`, [operation(
    `${state}-${id}-v${record.revision}`,
    "renders",
    "image.render",
    "transition",
    { targetId: id, expectedRevision: record.revision, params: { state, patch } },
  )]));
  return getRender(data, id);
}

function ensureMatchingRequest(existing, definition) {
  const value = requestValue(existing);
  const existingFingerprint = value?.invocationFingerprint || value?.inputFingerprint;
  const requestedFingerprint = definition.requestData.invocationFingerprint || definition.requestData.inputFingerprint;
  if (!value || existingFingerprint !== requestedFingerprint) {
    throw conflict(`Image operation ${definition.requestId} was reused with different input or profile bindings.`);
  }
  return value;
}

function normalizePrompts(contentPrompts, bindings) {
  const promptByGuide = new Map();
  for (const item of contentPrompts || []) {
    const guideId = String(item?.guideId || "");
    const content = String(item?.content || "").trim();
    if (!guideId || !content || promptByGuide.has(guideId)) throw new Error("Image prompts must contain one non-empty entry for each guideId.");
    promptByGuide.set(guideId, content);
  }
  const guideIds = [...new Set(bindings.map(item => item.guideId))];
  if (promptByGuide.size !== guideIds.length || guideIds.some(guideId => !promptByGuide.has(guideId))) {
    throw new Error("Image prompts do not match the frozen guide set.");
  }
  return guideIds.map(guideId => ({ guideId, content: promptByGuide.get(guideId) }));
}

function assembleFrozenPrompt(snapshot, contentPrompt) {
  const separator = snapshot.prompt?.separator ?? ", ";
  return {
    positive: [snapshot.prompt?.positivePrefix || "", normalizeString(contentPrompt), snapshot.prompt?.positiveSuffix || ""].filter(Boolean).join(separator),
    negative: snapshot.prompt?.negative || "",
  };
}

function buildRenders({ requestId, requestData }) {
  const prompts = new Map(requestData.contentPrompts.map(item => [item.guideId, item.content]));
  return requestData.profileBindings.map((binding, index) => {
    const snapshot = requestData.effectiveProfileSnapshots.find(item => item.snapshotId === binding.snapshotId);
    if (!snapshot) throw new Error(`Frozen ComfyUI snapshot ${binding.snapshotId} was not found.`);
    const contentPrompt = prompts.get(binding.guideId);
    const assembled = assembleFrozenPrompt(snapshot, contentPrompt);
    return {
      id: `image-render-${requestData.dedupeKey}-${index + 1}`,
      data: {
        requestId,
        ordinal: requestData.ordinal,
        renderOrdinal: index + 1,
        profileId: binding.id,
        profileRevision: binding.revision,
        profileDigest: binding.digest,
        profileEffectiveDigest: binding.effectiveDigest,
        profileSnapshotId: binding.snapshotId,
        guideId: binding.guideId,
        connectionId: binding.connectionId,
        connectionBaseUrl: binding.connectionBaseUrl,
        contentPrompt,
        positivePrompt: assembled.positive,
        negativePrompt: assembled.negative,
        workflowDigest: binding.workflowDigest,
        outputNodeIds: binding.outputNodeIds,
        seed: null,
        filenamePrefix: null,
        payloadDigest: null,
        attemptNumber: 0,
        attemptId: null,
        promptId: null,
        state: "pending",
        chatFolder: requestData.chatFolder,
        outputs: [],
        error: null,
        errorKind: null,
        lastCheckedAt: null,
        submittedAt: null,
        completedAt: null,
      },
    };
  });
}

export function prepareImageOperation({ operationId, ordinal, source, profiles, chatFolder, derivedFrom = null, intent = null, continuityContext = {}, now = new Date() }) {
  if (typeof operationId !== "string" || !operationId) throw new Error("Image generation requires a stable operationId.");
  const effectiveProfileSnapshots = profiles.map(profileSnapshot);
  const profileBindings = effectiveProfileSnapshots.map(profileBinding);
  const invocationIntent = normalizeImageOperationIntent(intent || {
    operationId,
    profileIds: profiles.map(profile => profile.id),
    inputPolicy: { kind: source.sourceKind },
    customBrief: source.sourceKind === "custom-brief" ? source.imageTarget : "",
    workflowOutput: source.sourceKind === "workflow-output" ? source.imageTarget : "",
    userDirection: source.userDirection,
    derivedFrom,
  });
  const requestId = `image-request-${operationId}`;
  const frozenContinuityContext = {
    playerName: normalizeString(continuityContext.playerName),
    playerDescription: normalizeString(continuityContext.playerDescription),
    primaryCharacters: normalizeString(continuityContext.primaryCharacters),
  };
  return {
    requestId,
    requestData: {
      ordinal,
      sourceKind: source.sourceKind,
      triggerKind: source.triggerKind,
      referenceContext: source.referenceContext || "",
      imageTarget: source.imageTarget,
      userDirection: source.userDirection || "",
      promptState: "preparing",
      invocationIntent,
      invocationFingerprint: fingerprint(invocationIntent),
      resolvedInputFingerprint: resolvedInputFingerprint(source, effectiveProfileSnapshots, derivedFrom, frozenContinuityContext),
      inputFingerprint: fingerprint(invocationIntent),
      contentPrompts: [],
      selectedProfileIds: profileBindings.map(item => item.id),
      profileBindings,
      effectiveProfileSnapshots,
      continuityContext: frozenContinuityContext,
      chatFolder,
      derivedFrom,
      dedupeKey: operationId,
      createdAt: now.toISOString(),
    },
  };
}

export async function ensurePreparedImageRequest({ data, definition }) {
  const existing = await getRequest(data, definition.requestId);
  if (existing) {
    const value = ensureMatchingRequest(existing, definition);
    return { created: false, request: existing, route: value.promptState === "ready" ? "reuse" : "prompt" };
  }
  await submit(data, batch(`image-prepare-${definition.requestId}`, [
    operation(`prepare-${definition.requestId}`, "requests", "image.request", "create", { targetId: definition.requestId, data: definition.requestData }),
  ]));
  return { created: true, request: await getRequest(data, definition.requestId), route: "prompt" };
}

export async function finalizePreparedImageOperation({ data, requestId, contentPrompts }) {
  const existing = await getRequest(data, requestId);
  const current = requestValue(existing);
  if (!existing || !current) throw new Error(`Prepared image request ${requestId} was not found.`);
  if (current.promptState === "ready") return { created: false, request: existing, renders: await findRenders(data, requestId) };
  if (!Array.isArray(current.effectiveProfileSnapshots) || !current.effectiveProfileSnapshots.length) {
    throw Object.assign(new Error(`Prepared image request ${requestId} predates frozen profile snapshots and cannot be recovered safely.`), { code: "image_recovery_unsupported" });
  }
  const prompts = normalizePrompts(contentPrompts, current.profileBindings);
  const requestData = { ...current, promptState: "ready", contentPrompts: prompts, resolvedInputFingerprint: fingerprint({ resolved: current.resolvedInputFingerprint, contentPrompts: prompts }) };
  const renders = buildRenders({ requestId, requestData });
  await submit(data, batch(`image-finalize-${requestId}-v${existing.revision}`, [
    operation(`finalize-${requestId}-v${existing.revision}`, "requests", "image.request", "update", { targetId: requestId, expectedRevision: existing.revision, data: requestData }),
    ...renders.map(item => operation(`create-${item.id}`, "renders", "image.render", "create", { targetId: item.id, data: item.data })),
  ]));
  return { created: true, request: await getRequest(data, requestId), renders: await Promise.all(renders.map(item => getRender(data, item.id))) };
}

export function buildImageOperation({ operationId, ordinal, source, profiles, contentPrompts, chatFolder, services, derivedFrom = null, intent = null, continuityContext = {}, now = new Date() }) {
  const normalizedIntent = normalizeImageOperationIntent(intent || { operationId, profileIds: profiles.map(profile => profile.id), inputPolicy: { kind: source.sourceKind }, customBrief: source.sourceKind === "custom-brief" ? source.imageTarget : "", workflowOutput: source.sourceKind === "workflow-output" ? source.imageTarget : "", userDirection: source.userDirection, derivedFrom });
  const definition = prepareImageOperation({ operationId, ordinal, source, profiles, chatFolder, derivedFrom, intent: normalizedIntent, continuityContext, now });
  const prompts = normalizePrompts(contentPrompts, definition.requestData.profileBindings);
  definition.requestData = { ...definition.requestData, promptState: "ready", contentPrompts: prompts, resolvedInputFingerprint: fingerprint({ resolved: definition.requestData.resolvedInputFingerprint, contentPrompts: prompts }) };
  definition.renders = buildRenders({ requestId: definition.requestId, requestData: definition.requestData });
  definition.profiles = profiles;
  definition.services = services;
  return definition;
}

export async function ensureImageOperation({ data, definition }) {
  const existing = await getRequest(data, definition.requestId);
  if (existing) {
    const value = ensureMatchingRequest(existing, definition);
    if (value.promptState === "preparing") {
      return finalizePreparedImageOperation({ data, requestId: definition.requestId, contentPrompts: definition.requestData.contentPrompts });
    }
    return { created: false, request: existing, renders: await findRenders(data, definition.requestId) };
  }
  await submit(data, batch(`image-create-${definition.requestId}`, [
    operation(`create-${definition.requestId}`, "requests", "image.request", "create", { targetId: definition.requestId, data: definition.requestData }),
    ...definition.renders.map(item => operation(`create-${item.id}`, "renders", "image.render", "create", { targetId: item.id, data: item.data })),
  ]));
  return {
    created: true,
    request: await getRequest(data, definition.requestId),
    renders: await Promise.all(definition.renders.map(item => getRender(data, item.id))),
  };
}

function attemptPromptId(renderId, attemptNumber) {
  const hex = createHash("sha256").update(`${renderId}:${attemptNumber}`).digest("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function attemptSeed(renderId, attemptNumber, range) {
  // Delegated so both copies of the runtime derivation — this module and the Web bridge — always
  // produce the same seed for the same render and attempt.
  return deriveSeed(renderId, attemptNumber, range);
}

function renderExecutionParameters(record, value, snapshot, attemptNumber, promptId) {
  const seed = attemptSeed(record.id, attemptNumber, snapshot?.seedRange);
  const filenamePrefix = `${String(value.ordinal).padStart(4, "0")}-r${String(value.renderOrdinal).padStart(2, "0")}-${value.profileId}-final`;
  const payloadDigest = fingerprint({
    snapshotId: snapshot.snapshotId,
    effectiveDigest: snapshot.effectiveDigest,
    positivePrompt: value.positivePrompt,
    negativePrompt: value.negativePrompt,
    seed,
    filenamePrefix,
    promptId,
  });
  return { seed, filenamePrefix, payloadDigest };
}

export async function executeImageOperation({ data, services, requestId, renders }) {
  const requestRecord = await getRequest(data, requestId);
  const request = requestValue(requestRecord);
  const snapshots = new Map((request?.effectiveProfileSnapshots || []).map(item => [item.snapshotId, item]));
  const outcomes = [];
  for (const sourceRecord of renders) {
    let record = await getRender(data, sourceRecord.id);
    let value = renderValue(record);
    if (!record || !value) throw new Error(`Image render ${sourceRecord.id} was not found.`);
    if (["completed", "failed", "cancelled"].includes(value.state)) {
      outcomes.push({ renderId: record.id, state: value.state, outputs: value.outputs || [], executionState: value.state === "failed" ? "failed" : undefined, errorKind: value.errorKind || null, error: value.error || null, promptId: value.promptId || null });
      continue;
    }
    let phase = "pre-submit";
    try {
      let result;
      if ((value.state === "submitting" || value.state === "submitted") && value.promptId) {
        phase = "recovery";
        // The frozen workflow is passed along so a resumed history is read with the same node
        // lineage the original submission used.
        const recoverySnapshot = snapshots.get(value.profileSnapshotId) || null;
        result = await services.comfy.resumeRender({ connectionId: value.connectionId, connectionBaseUrl: value.connectionBaseUrl, promptId: value.promptId, outputNodeIds: value.outputNodeIds, workflow: recoverySnapshot?.workflow || null });
      } else {
        const snapshot = snapshots.get(value.profileSnapshotId);
        if (!snapshot) throw Object.assign(new Error(`Image render ${record.id} has no recoverable frozen profile snapshot.`), { code: "comfy_pre_submit_failure" });
        const attemptNumber = Number(value.attemptNumber || 0) + 1;
        const promptId = attemptPromptId(record.id, attemptNumber);
        const execution = renderExecutionParameters(record, value, snapshot, attemptNumber, promptId);
        record = await transition(data, record, "submitting", { attemptNumber, attemptId: promptId, promptId, ...execution, error: null, errorKind: null, lastCheckedAt: null, submittedAt: null, completedAt: null, outputs: [] });
        value = renderValue(record);
        phase = "submission-uncertain";
        const generate = typeof services.comfy.generateFrozen === "function" ? services.comfy.generateFrozen.bind(services.comfy) : services.comfy.generate.bind(services.comfy);
        result = await generate({
          snapshot,
          profileId: value.profileId,
          contentPrompt: value.contentPrompt,
          positivePrompt: value.positivePrompt,
          negativePrompt: value.negativePrompt,
          chatFolder: value.chatFolder,
          filenamePrefix: value.filenamePrefix,
          seed: value.seed,
          payloadDigest: value.payloadDigest,
          promptId,
          onSubmitted: async submission => {
            if (submission.promptId !== promptId) throw Object.assign(new Error("ComfyUI did not preserve the caller-supplied prompt ID."), { code: "comfy_prompt_id_mismatch" });
            record = await transition(data, record, "submitted", { submittedAt: submission.submittedAt, error: null, errorKind: null, lastCheckedAt: new Date().toISOString() });
            value = renderValue(record);
            phase = "recovery";
          },
        });
      }
      record = await transition(data, record, "completed", { outputs: result.outputs, completedAt: result.completedAt, error: null, errorKind: null, lastCheckedAt: new Date().toISOString(), warnings: Array.isArray(result.warnings) ? result.warnings : [] });
      outcomes.push({ renderId: record.id, state: "completed", outputs: result.outputs, warnings: Array.isArray(result.warnings) ? result.warnings : [] });
    } catch (error) {
      record = await getRender(data, record.id);
      value = renderValue(record);
      const errorKind = phase === "pre-submit" || error?.code === "comfy_pre_submit_failure"
        ? "pre-submit-failure"
        : CONFIRMED_FAILURES.has(error?.code)
          ? "confirmed-rejection"
          : "submission-uncertain";
      if (errorKind !== "submission-uncertain" && ["pending", "submitting", "submitted"].includes(value?.state)) {
        try {
          record = await transition(data, record, "failed", { error: error.message, errorKind, lastCheckedAt: new Date().toISOString(), completedAt: new Date().toISOString() });
          value = renderValue(record);
        } catch (transitionError) {
          outcomes.push({ renderId: record.id, state: value?.state || "pending", executionState: "failed", errorKind, error: `${error.message}; state update failed: ${transitionError.message}`, promptId: value?.promptId || null });
          continue;
        }
      } else if (errorKind === "submission-uncertain" && ["submitting", "submitted"].includes(value?.state)) {
        try {
          record = await transition(data, record, value.state, { error: error.message, errorKind, lastCheckedAt: new Date().toISOString() });
          value = renderValue(record);
        } catch {}
      }
      outcomes.push({ renderId: record.id, state: value?.state || "pending", executionState: errorKind === "submission-uncertain" ? "recovery-required" : "failed", errorKind, error: error.message, promptId: value?.promptId || null });
    }
  }
  const completed = outcomes.filter(item => item.state === "completed").length;
  const recovery = outcomes.filter(item => item.executionState === "recovery-required" || ["submitting", "submitted"].includes(item.state)).length;
  const failed = outcomes.filter(item => item.executionState === "failed" || item.state === "failed").length;
  const executionStatus = recovery
    ? completed || failed ? "partially-completed" : "recovery-required"
    : failed
      ? completed ? "partially-completed" : "failed"
      : "completed";
  return {
    requestId,
    outcomes,
    executionStatus,
    recoveryRequired: recovery > 0,
    error: recovery || failed ? outcomes.filter(item => item.error).map(item => `${item.renderId}: ${item.error}`).join("; ") : null,
  };
}

export { requestValue, renderValue };
