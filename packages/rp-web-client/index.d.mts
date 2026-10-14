import type { Connection, ReadContext, State } from "../rp-web-contract/index.mjs";
export interface RequestOptions {
  method?: string; headers?: Record<string, string>; body?: unknown; signal?: AbortSignal;
  timeoutMs?: number; context?: ReadContext | null; binary?: boolean; envelope?: boolean;
}
export interface ClientOptions {
  baseUrl: string;
  fetch?: typeof fetch;
  auth?: (request: { path: string; method: string; connection: Connection | null }) => Record<string, string> | Promise<Record<string, string>>;
  transport?: { request: typeof fetch } | null;
}
export interface WatchMetadata { kind: "snapshot" | "change"; context: ReadContext | null }
export interface RpClient {
  request<T = unknown>(path: string, options?: RequestOptions): Promise<T>;
  connect(): Promise<Connection>;
  watch<T>(path: string, listener: (value: T, metadata: WatchMetadata) => void | Promise<void>, options?: { intervalMs?: number; maximumBackoffMs?: number; signal?: AbortSignal; visible?: () => boolean; onError?: (error: unknown) => void }): () => void;
  readonly connection: Connection | null;
  readonly readContext: ReadContext | null;
  readonly cacheKey: string;
  setReadContext(context: ReadContext | null): void;
  onContext(listener: (context: ReadContext | null) => void): () => void;
  preview(executionId: string | null): void;
  resourceUrl(path: string, options?: { context?: ReadContext | null }): string;
  loadResource(path: string, options?: RequestOptions): Promise<{ url: string; release(): void }>;
  dispose(): void;
  chat: { state(): Promise<State>; transcript(): Promise<unknown>; input(value: { content: string; operationId: string }): Promise<unknown>; opening(value: { openingId: string; playerName?: string }): Promise<State>; resume(sessionId: string): Promise<State> };
  attempts: { list(): Promise<unknown>; adopt(id: string, value: { expectedRevision: number }): Promise<State>; regenerate(value: { executionId: string }): Promise<State> };
  modules: { list(): Promise<unknown>; query(moduleId: string, bindingId: string, query?: string): Promise<unknown>; settings(moduleId: string, bindingId: string): Promise<unknown>; update(moduleId: string, bindingId: string, value: { expectedRevision: number; operationId: string; values: Record<string, unknown> }): Promise<unknown> };
}
export function createRpClient(options: ClientOptions): RpClient;
