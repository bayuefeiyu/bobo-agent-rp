// 页面共享依赖；面板只依赖此模块，不反向加载应用入口。
export const state = {};
export const elements = {};
let boundDocument = null;
export function initializePageContext() {
  if (boundDocument === document) return false;
  boundDocument = document;
  for (const key of Object.keys(state)) delete state[key];
  for (const key of Object.keys(elements)) delete elements[key];
  Object.assign(state, {
  card: null,
  snapshot: null,
  sessions: [],
  cards: [],
  settings: null,
  sending: false,
  switching: false,
  playerNameDirty: false,
  avatarVersion: Date.now(),
  activePanel: "story",
  featureModules: [],
  featureModulePayload: null,
  featureModuleSignature: "",
  expandedFeatureModules: new Set(),
  promptControlDrafts: new Map(),
  moduleDisplayDraft: null,
  models: [],
  agents: [],
  workflows: [],
  workflowRuns: [],
  activeWorkflowId: "standard-rp",
  workflowPolicy: null,
  workflowRenderSignature: "",
  tokenRenderSignature: "",
  imageGeneration: null,
  imageGenerationRegion: null,
  imagePromptRenderId: null,
  imageViewerItems: [],
  imageViewerIndex: 0,
  imageViewerZoomed: false,
});
  Object.assign(elements, {
  appLayout: document.querySelector(".app-layout"),
  cardTitle: document.querySelector("#card-title"),
  connectionStatus: document.querySelector("#connection-status"),
  openingView: document.querySelector("#opening-view"),
  openingList: document.querySelector("#opening-list"),
  historyGroup: document.querySelector("#history-group"),
  historyList: document.querySelector("#history-list"),
  chooseChatButton: document.querySelector("#choose-chat-button"),
  chatView: document.querySelector("#chat-view"),
  messages: document.querySelector("#messages"),
  composer: document.querySelector("#composer"),
  input: document.querySelector("#message-input"),
  sendButton: document.querySelector("#send-button"),
  errorBanner: document.querySelector("#error-banner"),
  tabButtons: [...document.querySelectorAll(".tab-button:not([hidden])")],
  panels: [...document.querySelectorAll(".panel")],
  userSettingsForm: document.querySelector("#user-settings-form"),
  playerName: document.querySelector("#player-name"),
  playerDescription: document.querySelector("#player-description"),
  playerAvatar: document.querySelector("#player-avatar"),
  playerAvatarImage: document.querySelector("#player-avatar-image"),
  playerAvatarFallback: document.querySelector("#player-avatar-fallback"),
  savedProfile: document.querySelector("#saved-profile"),
  deleteSavedProfile: document.querySelector("#delete-saved-profile"),
  userSettingsStatus: document.querySelector("#user-settings-status"),
  fontSize: document.querySelector("#font-size"),
  fontSizeValue: document.querySelector("#font-size-value"),
  systemSettingsStatus: document.querySelector("#system-settings-status"),
  moduleSettingsForm: document.querySelector("#module-display-settings-form"),
  moduleSettingsList: document.querySelector("#module-settings-list"),
  moduleSettingsStatus: document.querySelector("#module-settings-status"),
  resetModuleSettings: document.querySelector("#reset-module-settings"),
  saveModuleSettings: document.querySelector("#save-module-settings"),
  cardSearch: document.querySelector("#card-search"),
  cardGrid: document.querySelector("#card-grid"),
  returnToSelector: document.querySelector("#return-to-selector"),
  handoffOverlay: document.querySelector("#handoff-overlay"),
  handoffTitle: document.querySelector("#handoff-title"),
  handoffDescription: document.querySelector("#handoff-description"),
  moduleList: document.querySelector("#card-module-list"),
  workflowSelect: document.querySelector("#workflow-select"),
  activateWorkflow: document.querySelector("#activate-workflow"),
  refreshWorkflows: document.querySelector("#refresh-workflows"),
  showActiveWorkflow: document.querySelector("#show-active-workflow"),
  workflowSummary: document.querySelector("#workflow-summary"),
  workflowNodeList: document.querySelector("#workflow-node-list"),
  workflowRunList: document.querySelector("#workflow-run-list"),
  workflowStatus: document.querySelector("#workflow-status"),
  refreshTokens: document.querySelector("#refresh-tokens"),
  tokenTotal: document.querySelector("#token-total"),
  tokenInput: document.querySelector("#token-input"),
  tokenOutput: document.querySelector("#token-output"),
  tokenCacheRead: document.querySelector("#token-cache-read"),
  tokenCacheWrite: document.querySelector("#token-cache-write"),
  tokenWorkflowList: document.querySelector("#token-workflow-list"),
  tokenNodeList: document.querySelector("#token-node-list"),
  tokenStatus: document.querySelector("#token-status"),
  imageRunDialog: document.querySelector("#image-run-dialog"),
  imageSourceKind: document.querySelector("#image-source-kind"),
  imageTurnCount: document.querySelector("#image-turn-count"),
  imageTargetKind: document.querySelector("#image-target-kind"),
  imageCustomBrief: document.querySelector("#image-custom-brief"),
  imageUserDirection: document.querySelector("#image-user-direction"),
  imageRunConfirm: document.querySelector("#image-run-confirm"),
  imageViewerDialog: document.querySelector("#image-viewer-dialog"),
  imageViewerImage: document.querySelector("#image-viewer-image"),
  imageViewerDownload: document.querySelector("#image-viewer-download"),
  imageViewerPrevious: document.querySelector("#image-viewer-previous"),
  imageViewerNext: document.querySelector("#image-viewer-next"),
  imageViewerZoom: document.querySelector("#image-viewer-zoom"),
  imagePromptDialog: document.querySelector("#image-prompt-dialog"),
  imageContentPrompt: document.querySelector("#image-content-prompt"),
  imagePositivePrompt: document.querySelector("#image-positive-prompt"),
  imageNegativePrompt: document.querySelector("#image-negative-prompt"),
  imageRegenerateScope: document.querySelector("#image-regenerate-scope"),
  imageRegenerateConfirm: document.querySelector("#image-regenerate-confirm"),
  comfyConnectionForm: document.querySelector("#comfy-connection-form"),
  comfyConnectionSelect: document.querySelector("#comfy-connection-select"),
  comfyConnectionId: document.querySelector("#comfy-connection-id"),
  comfyConnectionTitle: document.querySelector("#comfy-connection-title"),
  comfyConnectionUrl: document.querySelector("#comfy-connection-url"),
  comfyConnectionToken: document.querySelector("#comfy-connection-token"),
  comfyOutputPath: document.querySelector("#comfy-output-path"),
  comfyInsecureRemote: document.querySelector("#comfy-insecure-remote"),
  comfyTestConnection: document.querySelector("#comfy-test-connection"),
  comfyConnectionStatus: document.querySelector("#comfy-connection-status"),
  comfyProfileDocuments: document.querySelector("#comfy-profile-documents"),
});
  return true;
}

export async function request(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers || {}) },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error || "请求失败，请稍后重试。");
    error.status = response.status;
    if (response.status === 409 && isInactiveBridgeMessage(error.message)) {
      showHandoff("这个页面已经失效", "它属于已经结束的 Pi 会话。请关闭此页，并使用最新打开的 Web RP 页面。");
    }
    throw error;
  }
  return payload;
}

export function showError(error) {
  elements.errorBanner.textContent = error.message || String(error);
  elements.errorBanner.hidden = false;
  window.setTimeout(() => { elements.errorBanner.hidden = true; }, 5000);
}

export function componentReference(ownerModuleId, id) {
  const reference = String(id || "");
  return reference.includes("/") || !ownerModuleId ? reference : `${ownerModuleId}/${reference}`;
}

export function runWorkflowReference(run) { return componentReference(run.ownerModuleId, run.workflowId); }

export const modelPresets = {
  openai: { baseUrl: "https://api.openai.com/v1", api: "openai-responses" },
  anthropic: { baseUrl: "https://api.anthropic.com/v1", api: "anthropic-messages" },
  deepseek: { baseUrl: "https://api.deepseek.com/v1", api: "openai-completions" },
  openrouter: { baseUrl: "https://openrouter.ai/api/v1", api: "openai-completions" },
  gemini: { baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", api: "openai-completions" },
  moonshot: { baseUrl: "https://api.moonshot.cn/v1", api: "openai-completions" },
  dashscope: { baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", api: "openai-completions" },
  siliconflow: { baseUrl: "https://api.siliconflow.cn/v1", api: "openai-completions" },
  custom: { baseUrl: "", api: "openai-completions" },
};

export function appendModuleEmpty(container, message) {
  const empty = document.createElement("p");
  empty.className = "module-empty";
  empty.textContent = message || "暂无内容。";
  container.append(empty);
}

export function showHandoff(title, description) {
  state.switching = true;
  elements.appLayout.inert = true;
  elements.handoffTitle.textContent = title;
  elements.handoffDescription.textContent = description;
  elements.handoffOverlay.hidden = false;
  elements.handoffOverlay.focus();
  document.title = "页面已交接 · Pi RP";
}

export function isInactiveBridgeMessage(message) {
  return /bridge is not active|closed Pi session/i.test(message || "");
}
