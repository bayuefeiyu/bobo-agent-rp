

import { readFile, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";

import { createRpConfigStore } from "./rp-config-store.mjs";

import { workflowProcessRecordPath } from "./rp-workspace.mjs";
import { hasCallRecords, readCallRecords } from "./rp-call-records.mjs";

import { workflowNodeWorkspace } from "./rp-data-artifacts.mjs";

import { frontendBinding, validateFrontendWorkflowPayload } from "./rp-module-frontend.mjs";

import { httpError, openLocalDocument } from "./rp-host-utils.ts";
import type { ActiveBridge, RpRun, FeatureModule } from "./rp-host-types.ts";
import type { HostSessionScope } from "./rp-host-session-scope.ts";

type Dependencies = {
  scope: HostSessionScope<ActiveBridge>;
  configStore: ReturnType<typeof createRpConfigStore>;
  cardSettingsPath: string;
  startManualBackgroundWorkflow: (workflowId: string, payload: any) => Promise<{ activated: string; run: any; }>;
  turn: { current: RpRun | null };
  requireFrontendModule: (moduleId: string) => FeatureModule;
};
export function createWorkflowsWebBridge({ scope, configStore, cardSettingsPath, startManualBackgroundWorkflow, turn, requireFrontendModule }: Dependencies) {
return {
reexecuteWorkflow: async (runId: string, value: any = {}) => {
  const active = scope.requireCurrent();
  if (scope.executionId) throw httpError(409, "Return to the adopted narrative before re-executing module work.");
  if (active.pending || !active.context.isIdle()) throw httpError(409, "Wait for the current foreground execution.");
  const run = active.workflowEngine.snapshot().find((item: any) => item.id === runId);
  if (!run) throw httpError(404, "Workflow execution was not found.");
  if (run.kind === "foreground") throw httpError(409, "Use the narrative attempt endpoint for a foreground workflow.");
  return active.workflowEngine.reexecute(runId, { id: value.executionId, currentTurn: active.turn });
},
listWorkflows: async () => {
            return { activeWorkflowId: scope.requireCurrent()?.activeWorkflowId || null, workflows: await configStore.listWorkflows() };
          },
listWorkflowRuns: async () => {
            if (!scope.requireCurrent()?.sessionDirectory) return { runs: [] };
            const persisted = await readFile(resolve(scope.requireChat().sessionDirectory, "workflow", "runs.jsonl"), "utf8").then(text => text.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line))).catch(error => {
              if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
              throw error;
            });
            const latest = new Map<string, any>();
            for (const run of persisted) latest.set(run.id, { ...run, live: false });
            const blockingRunIds = new Set(scope.requireCurrent().workflowEngine.blockingTurnRuns().map((item: any) => item.runId));
            for (const run of scope.requireCurrent().workflowEngine.snapshot()) latest.set(run.id, { ...run, live: true, blocksNextTurn: blockingRunIds.has(run.id) });
            const runs = await Promise.all([...latest.values()].map(async run => {
              const enriched = structuredClone(run);
              for (const node of Object.values(enriched.nodes || {}) as any[]) {
                if (await hasCallRecords(scope.requireChat().sessionDirectory, run.id, node.id)) node.processRecord = { ...node.processRecord, available: true, callsAvailable: true };
                const teamStatePath = resolve(workflowNodeWorkspace(scope.requireCurrent()!.sessionDirectory!, run.workflowId, run.id, node.id), "team", "state.json");
                const teamState = await readFile(teamStatePath, "utf8").then(JSON.parse).catch(error => {
                  if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
                  throw error;
                });
                if (!teamState) continue;
                node.team = {
                  protocol: teamState.protocol || "meeting",
                  activeMemberId: teamState.activeMemberId || null,
                  currentStage: teamState.stageState ? teamState.stageState.currentIndex + 1 : 1,
                  activation: teamState.activation || 0,
                  deliveries: (teamState.deliveryReceipts || []).map((receipt: any) => ({ ...receipt, status: "completed" })),
                  calls: [...new Map((teamState.events || []).filter((event: any) => event.detail?.workflow && ["workflow-started", "workflow-returned", "tool-failed"].includes(event.type)).map((event: any) => [event.detail.operationId || event.detail.workflow, { id: event.detail.operationId, target: event.detail.workflow, memberId: event.memberId, status: event.type === "workflow-returned" ? "completed" : event.type === "tool-failed" ? "failed" : "running", error: event.type === "tool-failed" ? event.text : null }])).values()],
                  status: teamState.status,
                  phase: teamState.phase,
                  round: teamState.round,
                  speechCount: teamState.speechSeq || 0,
                  taskCounts: Object.values(teamState.tasks || {}).reduce((counts: any, task: any) => ({ ...counts, [task.status]: (counts[task.status] || 0) + 1 }), {}),
                  budgets: teamState.budgets || {},
                  usage: teamState.usage || null,
                  error: teamState.error || null,
                  failedMember: teamState.lastMemberFailure || null,
                  transcriptAvailable: true,
                };
              }
              return enriched;
            }));
            return { runs: runs.sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt))) };
          },
openWorkflowTeamTranscript: async (runId: string, nodeId: string) => {
            if (!scope.requireCurrent()?.sessionDirectory) throw httpError(409, "Select an opening or saved chat before opening a team transcript.");
            const live = scope.requireCurrent().workflowEngine.snapshot().find((item: any) => item.id === runId);
            const persistedRun = live ? null : await readFile(resolve(scope.requireChat().sessionDirectory, "workflow", "runs.jsonl"), "utf8")
              .then(text => text.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)).reverse().find(item => item.id === runId))
              .catch(error => {
                if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
                throw error;
              });
            const run = live || persistedRun;
            if (!run?.nodes?.[nodeId]) throw httpError(404, "Team workflow node was not found.");
            const transcriptPath = resolve(workflowNodeWorkspace(scope.requireChat().sessionDirectory, run.workflowId, runId, nodeId), "team", "shared", "TRANSCRIPT.md");
            await readFile(transcriptPath, "utf8").catch(error => {
              if ((error as NodeJS.ErrnoException).code === "ENOENT") throw httpError(404, "Team transcript was not found.");
              throw error;
            });
            try { await openLocalDocument(transcriptPath); }
            catch (error) { throw httpError(500, `Could not open the team transcript: ${(error as Error).message}`); }
            return { opened: true, path: relative(scope.requireCurrent().context.cwd, transcriptPath).replaceAll("\\", "/") };
          },
getWorkflowNodeProcessRecord: async (runId: string, nodeId: string, callId?: string, summaryOnly = false) => {
            const active = scope.requireChat();
            if (!active.sessionDirectory) throw httpError(409, "Select a chat first.");
            const live = active.workflowEngine.snapshot().find((run: any) => run.id === runId);
            const run = live || await readFile(resolve(active.sessionDirectory, "workflow/runs.jsonl"), "utf8")
              .then(text => text.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)).reverse().find(run => run.id === runId))
              .catch(error => { if (error.code === "ENOENT") return null; throw error; });
            if (!run?.nodes?.[nodeId]) throw httpError(404, "Workflow node was not found.");
            const record = await readCallRecords(active.sessionDirectory, runId, nodeId);
            const legacy = record.calls.length || summaryOnly ? null : await readFile(workflowProcessRecordPath(resolve(active.sessionDirectory, "workflow/process-records"), runId, nodeId), "utf8")
              .catch(error => { if (error.code === "ENOENT") return null; throw error; });
            const selectedCall = callId ? record.calls.find(call => call.id === callId) : record.calls.at(-1);
            if (callId && !selectedCall) throw httpError(404, "Model call was not found.");
            const calls = record.calls.map(({ request, response, tools, ...summary }) => ({ ...summary, toolEventCount: tools.length }));
            return { ...record, calls, selectedCall: summaryOnly ? null : selectedCall || null, runId, nodeId, workflowId: run.workflowId, workflowTitle: run.workflowTitle, status: run.nodes[nodeId].status,
              legacy: record.calls.length ? null : legacy, result: summaryOnly ? null : run.nodes[nodeId].output ?? null };
          },
openWorkflowNodeProcessRecord: async (runId: string, nodeId: string) => {
            if (!scope.requireCurrent()?.sessionDirectory) throw httpError(409, "Select an opening or saved chat before opening a workflow process record.");
            const runs = scope.requireCurrent().workflowEngine.snapshot();
            const live = runs.find((run: any) => run.id === runId);
            const persisted = live ? null : await readFile(resolve(scope.requireChat().sessionDirectory, "workflow", "runs.jsonl"), "utf8")
              .then(text => text.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)).reverse().find(run => run.id === runId))
              .catch(error => {
                if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
                throw error;
              });
            const run = live || persisted;
            if (!run?.nodes?.[nodeId]?.processRecord?.available) throw httpError(404, "Workflow node process record was not found.");
            const documentPath = workflowProcessRecordPath(resolve(scope.requireChat().sessionDirectory, "workflow", "process-records"), runId, nodeId);
            await readFile(documentPath, "utf8");
            try {
              await openLocalDocument(documentPath);
            } catch (error) {
              throw httpError(500, `Could not open the workflow process record: ${(error as Error).message}`);
            }
            return { opened: true, path: relative(scope.requireCurrent().context.cwd, documentPath).replaceAll("\\", "/") };
          },
activateWorkflow: async (workflowId: string, value: any) => {
            if (!scope.requireCurrent()) throw httpError(409, "This Web page belongs to a closed Pi session.");
            const workflow = await configStore.copyWorkflowToCard(workflowId);
            if (workflow.kind === "foreground") {
              scope.requireCurrent().activeWorkflowId = workflow.id;
              scope.requireCurrent().cardSettings.settings.activeWorkflowId = workflow.id;
              await writeFile(cardSettingsPath, `${JSON.stringify(scope.requireCurrent().cardSettings, null, 2)}\n`, "utf8");
              return { activated: workflow.id, startsOnNextInput: true };
            }
            if(!["turn-background","global-background"].includes(workflow.kind)||workflow.trigger?.type!=="manual")throw httpError(400,"此工作流由上级调用或指定事件触发，不能在此直接运行。");
            return startManualBackgroundWorkflow(workflow.id, value?.payload || {});
          },
retryWorkflowNode: async (runId: string, nodeId: string, value: any) => {
            if (!scope.requireCurrent()) throw httpError(409, "This Web page belongs to a closed Pi session.");
            const run = scope.requireCurrent().workflowEngine.snapshot().find((item: any) => item.id === runId);
            if (!run) throw httpError(404, "Workflow run was not found.");
            // A failed module node belongs to its owning module's workflow, not to the top-level
            // store. Resolving by owner is what makes panel retry work for module nodes at all.
            const workflow = await configStore.getModuleWorkflow(run.ownerModuleId || null, run.workflowId);
            if (workflow.kind === "foreground" && ["completed", "skipped", "failed", "cancelled"].includes(run.status)) {
              throw httpError(409, "A terminal foreground turn cannot be retried in place. Fix the card or configuration, then submit a new player turn.");
            }
            const node = workflow.nodes.find((item: any) => item.id === nodeId);
            if (!node) throw httpError(404, "Workflow node was not found.");
            if (value.saveAsCardDefault === true) {
              throw httpError(400, "请在模型指定页保存 Agent 的模型。此处重试只影响当前运行。");
            }
            const retried = await scope.requireCurrent().workflowEngine.retry(runId, nodeId, value.modelId, { memberId: value.memberId || null });
            return retried;
          },
recoverWorkflowNode: async (runId: string, nodeId: string) => {
            if (!scope.requireCurrent()) throw httpError(409, "This Web page belongs to a closed Pi session.");
            return scope.requireCurrent().workflowEngine.recover(runId, nodeId);
          },
cancelWorkflowRun: async (runId: string) => {
            if (!scope.requireCurrent()) throw httpError(409, "This Web page belongs to a closed Pi session.");
            const cancelled = await scope.requireCurrent().workflowEngine.cancel(runId);
            if (turn.current?.workflowRunId === runId) {
              if (!scope.requireCurrent().context.isIdle()) scope.requireCurrent().context.abort();
              scope.requireCurrent().pending = false;
              turn.current = null;
            }
            return cancelled;
          },
skipWorkflowRun: async (runId: string) => {
            if (!scope.requireCurrent()) throw httpError(409, "This Web page belongs to a closed Pi session.");
            const skipped = await scope.requireCurrent().workflowEngine.skip(runId);
            if (turn.current?.workflowRunId === runId) {
              if (!scope.requireCurrent().context.isIdle()) scope.requireCurrent().context.abort();
              scope.requireCurrent().pending = false;
              turn.current = null;
            }
            return skipped;
          },
runModuleFrontendWorkflow: async (moduleId: string, regionId: string, workflowId: string, value: any) => {
            if (scope.executionId) throw httpError(409, "Return to the adopted narrative before starting module work.");
            const module = requireFrontendModule(moduleId);
            let region;
            let payload;
            try {
              region = frontendBinding(module, regionId, "workflow-controls");
              payload = validateFrontendWorkflowPayload(region, workflowId, value?.payload || {});
            } catch (error) { throw httpError(400, (error as Error).message); }
            return startManualBackgroundWorkflow(workflowId.includes("/") ? workflowId : `${moduleId}/${workflowId}`, { ...payload, frontendModuleId: moduleId, frontendBindingId: regionId });
          }
};
}
