import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { RpWorkflowEngine } from "./rp-workflow-engine.mjs";
export type { RpDataStore } from "./rp-data-store.mjs";
export type WebMessage = {
  sequence: number;
  turn: number;
  role: "user" | "assistant";
  kind: "opening" | "message";
  content: string;
  createdAt: string;
  editedAt?: string;
  narrativeSource?: Record<string, unknown>;
};

export type RecordEnvelope = {
  schemaVersion: 1;
  id: string;
  source: string;
  sequence: number;
  revision: number;
  createdAt: string;
  updatedAt: string;
  binding: { messageId: string | null; turn: number };
  metadata: { recordType: string; entityIds: string[]; tags: string[]; title?: string; narrativeSource?: Record<string, unknown> };
  data: Record<string, any>;
};

export type RetrievalPolicy = {
  schemaVersion: 2;
  code: { profile: "default" | "custom"; selector: Record<string, any> };
  agent: { mode: "disabled" | "append" | "override"; fallback: "code"; onNotTriggered: "code" | "empty"; maxRecords: number };
};

export type ActiveBridge = {
  cardDirectory: string;
  isolatedRuntime: boolean;
  cardId: string;
  cardName: string;
  context: ExtensionContext;
  candidateRecordId: string;
  candidateSessionDirectory: string;
  recordId: string | null;
  sessionDirectory: string | null;
  openingId: string | null;
  playerName: string;
  playerDescription: string;
  stableCardContext: string;
  featureModules: FeatureModule[];
  commonSettings: CommonSettings;
  cardSettings: CardSettings;
  messages: RecordEnvelope[];
  messagePolicy: RetrievalPolicy;
  messageSkillPath: string | null;
  messageSkillDescription: string;
  contextProcessors: ContextProcessor[];
  pending: boolean;
  turn: number;
  configStore: any;
  configProfiles: any;
  configToken: string;
  comfyUi: any;
  workflowEngine: RpWorkflowEngine;
  activeWorkflowId: string;
  close: () => Promise<void>;
  url: string;
  /**
   * Set when a foreground turn ended without publishing player-visible prose. The UI states it
   * explicitly, because "no prose" and "this turn needed no prose" must not look the same.
   *
   * `recordId` ties the note to the chat it happened in, so a failure is not reported while the
   * player is looking at a different chat.
   */
  lastTurnFailure?: { turn: number; detail: string | null; at: string; recordId: string | null } | null;
};

export type RpRun = {
  cardId: string;
  recordId: string;
  submittedText: string;
  submittedSequence: number;
  assistantContent: string;
  automaticSelections: Record<string, string[]>;
  agentQueries: Array<Record<string, unknown>>;
  agentSources: string[];
  processorSelections: Array<{ id: string; include: string[]; error?: string }>;
  contextContent: string | null;
  phase: "narrative" | "done";
  assistantMessageId: string | null;
  workflowRunId?: string | null;
  workflowNarrativeNodeId?: string | null;
  resolveNarrative?: ((value: any) => void) | null;
  rejectNarrative?: ((error: Error) => void) | null;
  modelHeadPrompt?: string | null;
  modelTailPrompt?: string | null;
  nodeAgentPrompt?: string | null;
  workflowNodePrompt?: string | null;
  baseModel?: any;
  phaseStartedAt?: number;
  agentSettled?: boolean;
  workflowCompleted?: boolean;
};

export type FeatureModule = {
  id: string;
  moduleKind: "data" | "resource" | "hybrid";
  title: string;
  description: string;
  surface: "frontend" | "background";
  contextOrder: number;
  displayOrder: number;
  basedOn: string | null;
  contract: any | null;
  resourceCatalog: any | null;
  resourceCatalogPath: string | null;
  view: { schemaVersion: number; regions: any[] };
  viewPath: string | null;
  moduleDirectory: string;
  skillPath: string;
  skillDescription: string;
  workflows: any[];
  agents: any[];
};

export type ContextProcessor = {
  id: string;
  description: string;
  contextOrder: number;
  failure: "error" | "omit";
  entryPath: string;
  definition: any;
  fragments: Array<{ id: string; title: string; path: string }>;
};

export type ModuleDisplaySettings = {
  order: string[];
  hidden: string[];
};

export type CommonSettings = {
  schemaVersion: 1;
  user: {
    playerName: string;
    description: string;
    savedProfiles: Array<{ name: string; description: string; avatar?: string }>;
  };
  system: { fontSize: number };
};

export type CardSettings = {
  schemaVersion: 1;
  cardId: string;
  settings: Record<string, unknown>;
};
