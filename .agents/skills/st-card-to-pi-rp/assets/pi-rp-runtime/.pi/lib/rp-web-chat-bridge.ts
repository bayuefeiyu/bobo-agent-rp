

import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { extname, resolve } from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { parseRecordLines, reviseRecord } from "./rp-records.mjs";

import { removeSavedUserProfile } from "./rp-user-profiles.mjs";
import { defaultCommonSettings } from "./rp-common-settings.mjs";

import { renderCardText } from "./rp-card-text.mjs";

import { bridgeBusy } from "./rp-turn-state.ts";

import { pruneWorkflowState } from "./rp-workspace.mjs";

import { cleanupArtifacts } from "./rp-data-artifacts.mjs";

import { messageSourceReference } from "./rp-narrative-source.mjs";

import { avatarExtension, resolveAvatarFile, unresolvedWorkflowCalls, httpError, resolveCardDirectory, resolveSessionDirectory, locateCardCover } from "./rp-host-utils.ts";
import type { WebMessage, RecordEnvelope, ActiveBridge, RpRun } from "./rp-host-types.ts";
import type { HostSessionScope } from "./rp-host-session-scope.ts";

type Dependencies = {
  webSnapshot: (extra?: Record<string, unknown>) => ReturnType<typeof import("./rp-turn-state.ts").webSnapshot>;
  scope: HostSessionScope<ActiveBridge>;
  manifest: any;
  commonSettingsDirectory: string;
  cardSettingsPath: string;
  isolatedRuntime: boolean;
  cardDirectory: string;
  context: ExtensionContext;
  boundCardId: string | null;
  pi: ExtensionAPI;
  cardSessionsDirectory: string;
  rewriteMessages: () => Promise<void>;
  updateMetadata: () => Promise<void>;
  pruneModuleRecords: (target: ActiveBridge, deletedMessageIds: Set<string>) => Promise<void>;
  hydrateNodeCompletionTurns: (sessionDirectory: string | null) => Promise<void>;
  restoreWorkflowRuns: (sessionDirectory: string | null) => Promise<void>;
  ensureFeatureModuleRecords: (target: ActiveBridge) => Promise<void>;
  appendMessage: (message: WebMessage) => Promise<RecordEnvelope | undefined>;
  dispatchWorkflowEvent: (event: any, parentRun: any) => Promise<void>;
  ensureActiveRecord: () => Promise<void>;
  turn: { current: RpRun | null };
};
export function createChatWebBridge({ webSnapshot, scope, manifest, commonSettingsDirectory, cardSettingsPath, isolatedRuntime, cardDirectory, context, boundCardId, pi, cardSessionsDirectory, rewriteMessages, updateMetadata, pruneModuleRecords, hydrateNodeCompletionTurns, restoreWorkflowRuns, ensureFeatureModuleRecords, appendMessage, dispatchWorkflowEvent, ensureActiveRecord, turn }: Dependencies) {
return {
renderCardText,
getState: async () => webSnapshot(),
getSettings: async () => ({
            common: scope.requireCurrent()?.commonSettings || defaultCommonSettings,
            card: scope.requireCurrent()?.cardSettings || { schemaVersion: 1, cardId: manifest.id, settings: {} },
          }),
getUserAvatar: async (playerName: string) => {
            if (!scope.requireCurrent()) throw httpError(409, "This Web page belongs to a closed Pi session. Use the newest Web RP page.");
            const profile = scope.requireCurrent().commonSettings.user.savedProfiles.find(item => item.name === playerName);
            if (!profile?.avatar) throw httpError(404, "This player profile has no avatar.");
            const path = resolveAvatarFile(commonSettingsDirectory, profile.avatar);
            const body = await readFile(path).catch(error => {
              if ((error as NodeJS.ErrnoException).code === "ENOENT") throw httpError(404, "Player avatar was not found.");
              throw error;
            });
            const extension = extname(path).toLowerCase();
            const mimeType = extension === ".png" ? "image/png"
              : extension === ".webp" ? "image/webp"
                : "image/jpeg";
            return { body, mimeType };
          },
updateUserAvatar: async ({ playerName, mimeType, body }: { playerName: string; mimeType: string; body: Buffer }) => {
            if (!scope.requireCurrent()) throw httpError(409, "This Web page belongs to a closed Pi session. Use the newest Web RP page.");
            let profile = scope.requireCurrent().commonSettings.user.savedProfiles.find(item => item.name === playerName);
            if (!profile) {
              profile = {
                name: playerName,
                description: playerName === scope.requireCurrent().playerName ? scope.requireCurrent().playerDescription : "",
              };
              scope.requireCurrent().commonSettings.user.savedProfiles.push(profile);
            }
            const previousAvatar = profile.avatar;
            const digest = createHash("sha256").update(playerName.normalize("NFC"), "utf8").digest("hex");
            const avatar = `avatars/${digest}${avatarExtension(mimeType)}`;
            await writeFile(resolveAvatarFile(commonSettingsDirectory, avatar), body);
            profile.avatar = avatar;
            scope.requireCurrent().cardSettings.settings.common = {
              ...(scope.requireCurrent().cardSettings.settings.common as Record<string, unknown> || {}),
              user: structuredClone(scope.requireCurrent().commonSettings.user),
            };
            await writeFile(cardSettingsPath, `${JSON.stringify(scope.requireCurrent().cardSettings, null, 2)}\n`, "utf8");
            if (previousAvatar && previousAvatar !== avatar) {
              await rm(resolveAvatarFile(commonSettingsDirectory, previousAvatar), { force: true });
            }
            return { common: scope.requireCurrent().commonSettings, playerName };
          },
listCards: async () => {
            if (isolatedRuntime) return [{ id: manifest.id, name: manifest.name, hasCover: Boolean(await locateCardCover(cardDirectory, manifest)) }];
            const cardsRoot = resolve(context.cwd, "cards");
            const directories = await readdir(cardsRoot, { withFileTypes: true });
            const cards = [];
            for (const directory of directories) {
              if (!directory.isDirectory()) continue;
              try {
                const directoryPath = resolveCardDirectory(context.cwd, directory.name);
                const cardManifest = JSON.parse(await readFile(resolve(directoryPath, "manifest.json"), "utf8"));
                if (!cardManifest.id || !cardManifest.name) continue;
                cards.push({
                  id: cardManifest.id,
                  name: cardManifest.name,
                  hasCover: Boolean(await locateCardCover(directoryPath, cardManifest)),
                });
              } catch (error) {
                console.warn(`Skipping invalid RP card ${directory.name}:`, (error as Error).message);
              }
            }
            return cards.sort((left, right) => left.name.localeCompare(right.name));
          },
getCardCover: async (cardId: string) => {
            if (boundCardId && cardId !== boundCardId) throw httpError(404, "This card belongs to another Pi process.");
            const directoryPath = resolveCardDirectory(context.cwd, cardId);
            const cardManifest = JSON.parse(await readFile(resolve(directoryPath, "manifest.json"), "utf8"));
            const cover = await locateCardCover(directoryPath, cardManifest);
            if (!cover) throw httpError(404, "Card cover was not found.");
            return cover;
          },
switchCard: async (cardId: string, forceNew = false) => {
            if (!scope.requireCurrent()) throw httpError(409, "This Web page belongs to a closed Pi session. Use the newest Web RP page.");
            if (boundCardId && cardId !== boundCardId) throw httpError(409, "Return to the card selector to open another card.");
            if (cardId === scope.requireCurrent().cardId && !forceNew) return { current: true };
            resolveCardDirectory(context.cwd, cardId);
            if (!scope.requireCurrent().context.isIdle()) throw httpError(409, "Wait for the current Pi response before switching chats.");
            pi.sendUserMessage(`/rp-web-reset ${cardId}`, { expandPromptTemplates: true });
            return { current: false, switching: true };
          },
listSessions: async () => {
            const directories = await readdir(cardSessionsDirectory, { withFileTypes: true }).catch(error => {
              if (error.code === "ENOENT") return [];
              throw error;
            });
            const sessions = [];
            for (const directory of directories) {
              if (!directory.isDirectory()) continue;
              const recordDirectory = resolveSessionDirectory(cardSessionsDirectory, directory.name);
              try {
                const [metadataText, messagesText] = await Promise.all([
                  readFile(resolve(recordDirectory, "session.json"), "utf8"),
                  readFile(resolve(recordDirectory, "messages.jsonl"), "utf8"),
                ]);
                const metadata = JSON.parse(metadataText);
                if (metadata.cardId && metadata.cardId !== manifest.id) continue;
                const recordMessages = parseRecordLines(messagesText) as RecordEnvelope[];
                if (recordMessages.length === 0) continue;
                const lastMessage = recordMessages.at(-1);
                sessions.push({
                  id: directory.name,
                  playerName: metadata.playerName || "玩家",
                  openingId: metadata.openingId || null,
                  messageCount: recordMessages.length,
                  lastMessage: lastMessage?.data.content || "",
                  updatedAt: metadata.updatedAt || lastMessage?.updatedAt || metadata.createdAt || "",
                });
              } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.warn(`Skipping invalid RP session ${directory.name}:`, (error as Error).message);
              }
            }
            return sessions.sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)));
          },
deleteSession: async (sessionId: string) => {
            if (!scope.requireCurrent()) throw httpError(409, "This Web page belongs to a closed Pi session. Use the newest Web RP page.");
            if (sessionId === scope.requireCurrent().recordId) throw httpError(409, "The active chat cannot be deleted.");
            const recordDirectory = resolveSessionDirectory(cardSessionsDirectory, sessionId);
            await rm(recordDirectory, { recursive: true, force: false }).catch(error => {
              if ((error as NodeJS.ErrnoException).code === "ENOENT") throw httpError(404, "Saved chat was not found.");
              throw error;
            });
            return { deleted: sessionId };
          },
updateMessage: async (sequence: number, content: string) => {
            if (!scope.requireCurrent()?.recordId || !scope.requireChat().sessionDirectory) throw httpError(409, "There is no active saved chat to edit.");
            if (bridgeBusy(scope.requireCurrent())) throw httpError(409, "Wait for the current turn and its blocking background workflows before editing messages.");
            const index = scope.requireCurrent().messages.findIndex(message => message.sequence === sequence);
            if (index === -1) throw httpError(404, "Saved message was not found.");
            const previous = scope.requireCurrent().messages[index];
            const updated = reviseRecord(previous, { ...previous.data, content }) as RecordEnvelope;
            scope.requireCurrent().messages[index] = updated;
            await rewriteMessages();
            await updateMetadata();
            return webSnapshot();
          },
deleteMessage: async (sequence: number) => {
            if (!scope.requireCurrent()?.recordId || !scope.requireChat().sessionDirectory) throw httpError(409, "There is no active saved chat to edit.");
            if (bridgeBusy(scope.requireCurrent())) throw httpError(409, "Wait for the current turn and its blocking background workflows before deleting messages.");
            const index = scope.requireCurrent().messages.findIndex(message => message.sequence === sequence);
            if (index === -1) throw httpError(404, "Saved message was not found.");
            const deleted = scope.requireCurrent().messages.splice(index);
            const deletedFromTurn = deleted.reduce((minimum, message) => Math.min(minimum, message.binding.turn), Number.POSITIVE_INFINITY);
            scope.requireCurrent().messages = scope.requireCurrent().messages.map((message, nextSequence) => ({ ...message, sequence: nextSequence }));
            scope.requireCurrent().turn = scope.requireCurrent().messages.reduce((maximum, message) => Math.max(maximum, message.binding.turn), 0);
            const deletedMessageIds = new Set(deleted.map(message => message.id));
            await pruneModuleRecords(scope.requireCurrent(), deletedMessageIds);
            if (Number.isSafeInteger(deletedFromTurn)) {
              await pruneWorkflowState(scope.requireChat().sessionDirectory, deletedFromTurn);
              scope.requireCurrent().workflowEngine.pruneRuns((run: any) => (Number.isSafeInteger(run.turn) && run.turn >= deletedFromTurn) || (Number.isSafeInteger(run.visibleThroughTurn) && run.visibleThroughTurn >= deletedFromTurn));
              await hydrateNodeCompletionTurns(scope.requireChat().sessionDirectory);
            }
            const becameEmpty = scope.requireCurrent().messages.length === 0;
            const deletedDirectory = scope.requireChat().sessionDirectory;
            if (becameEmpty) {
              await rm(deletedDirectory, { recursive: true, force: false });
            } else {
              await rewriteMessages();
              await updateMetadata();
            }
            if (becameEmpty) {
              scope.updateChat(null, null);
              scope.requireCurrent().openingId = null;
            }
            return webSnapshot();
          },
resumeSession: async (sessionId: string) => {
            if (!scope.requireCurrent()) throw httpError(409, "This Web page belongs to a closed Pi session. Use the newest Web RP page.");
            if (scope.requireCurrent().messages.length > 0) throw httpError(409, "The current Web RP session has already started.");
            const recordDirectory = resolveSessionDirectory(cardSessionsDirectory, sessionId);
            let metadata;
            let recordMessages: RecordEnvelope[];
            try {
              const [metadataText, messagesText] = await Promise.all([
                readFile(resolve(recordDirectory, "session.json"), "utf8"),
                readFile(resolve(recordDirectory, "messages.jsonl"), "utf8"),
              ]);
              metadata = JSON.parse(metadataText);
              recordMessages = parseRecordLines(messagesText) as RecordEnvelope[];
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code === "ENOENT") throw httpError(404, "Saved chat was not found.");
              throw error;
            }
            if (metadata.cardId && metadata.cardId !== scope.requireCurrent().cardId) {
              throw httpError(409, "Saved chat belongs to another card.");
            }
            if (recordMessages.length === 0) throw httpError(409, "Saved chat has no messages to resume.");

            scope.updateChat(sessionId, recordDirectory);
            scope.requireCurrent().openingId = metadata.openingId || manifest.default_opening || "opening-00";
            scope.requireCurrent().playerName = metadata.playerName || "玩家";
            scope.requireCurrent().playerDescription = metadata.playerDescription ?? scope.requireCurrent().commonSettings.user.description ?? "";
            scope.requireCurrent().messages = recordMessages;
            scope.requireCurrent().turn = recordMessages.reduce((maximum, message) => Math.max(maximum, message.binding.turn), 0);
            await hydrateNodeCompletionTurns(scope.requireChat().sessionDirectory);
            await restoreWorkflowRuns(scope.requireChat().sessionDirectory);
            await ensureFeatureModuleRecords(scope.requireCurrent());
            await updateMetadata();

            return webSnapshot();
          },
selectOpening: async (opening: any) => {
          if (!scope.requireCurrent()) throw httpError(409, "This Web page belongs to a closed Pi session. Use the newest Web RP page.");
          if (scope.requireCurrent().openingId) {
            return webSnapshot();
          }
          const createdAt = new Date().toISOString();
          scope.requireCurrent().openingId = opening.id;
          scope.requireCurrent().playerName = opening.playerName || scope.requireCurrent().playerName;
          const openingRecord = await appendMessage({
            sequence: 0,
            turn: 0,
            role: "assistant",
            kind: "opening",
            content: opening.content,
            createdAt,
            narrativeSource: { producerKind: "card", producerId: scope.requireCurrent().cardId, layer: "story", characterId: null },
          });
          await updateMetadata();
          await dispatchWorkflowEvent({ type: "after-opening", openingId: opening.id, messageId: openingRecord?.id || null }, { id: `opening-${opening.id}`, turn: 0 });
          return webSnapshot();
          },
submitInput: async (content: string) => {
          if (!scope.requireCurrent()?.openingId) throw httpError(409, "Select an opening first.");
          if (scope.requireCurrent().pending || !scope.requireCurrent().context.isIdle()) throw httpError(409, "Pi is still processing the previous message.");
          const blockers = scope.requireCurrent().workflowEngine.blockingTurnRuns();
          if (blockers.length) {
            const first = blockers[0];
            const additional = blockers.length > 1 ? ` and ${blockers.length - 1} other workflow(s)` : "";
            throw httpError(409, `Background workflow ${first.workflowTitle}${additional} must finish or be cancelled before the next player turn.`);
          }
          await ensureActiveRecord();
          scope.requireCurrent().lastTurnFailure = null;
          await cleanupArtifacts(scope.requireChat().sessionDirectory, { type: "turn", turn: scope.requireCurrent().turn + 1 });
          scope.requireCurrent().turn += 1;
          scope.requireCurrent().pending = true;
          const userRecord = await appendMessage({
            sequence: scope.requireCurrent().messages.length,
            turn: scope.requireCurrent().turn,
            role: "user",
            kind: "message",
            content,
            createdAt: new Date().toISOString(),
            narrativeSource: { producerKind: "user", producerId: null, layer: "in-world", characterId: null },
          });
          await updateMetadata();
          turn.current = {
            cardId: scope.requireCurrent().cardId,
            recordId: scope.requireCurrent().recordId!,
            submittedText: content,
            submittedSequence: scope.requireCurrent().messages.at(-1)!.sequence,
            assistantContent: "",
            automaticSelections: {},
            agentQueries: [],
            agentSources: [],
            processorSelections: [],
            contextContent: null,
            phase: "narrative",
            assistantMessageId: null,
            workflowRunId: null,
            workflowNarrativeNodeId: null,
            resolveNarrative: null,
            rejectNarrative: null,
            baseModel: scope.requireCurrent().context.model,
          };
          try {
            const workflow = await scope.requireCurrent().configStore.getWorkflow(scope.requireCurrent().activeWorkflowId);
            if (workflow.kind !== "foreground") throw new Error(`Active workflow ${workflow.id} is not a foreground workflow.`);
            const unresolved = unresolvedWorkflowCalls(workflow, scope.requireCurrent().featureModules);
            if (unresolved.length) {
              throw Object.assign(
                new Error(`Active workflow ${workflow.id} calls modules this card does not install: ${unresolved.join(", ")}. Install them or reconcile the workflow's call declarations.`),
                { code: "workflow_configuration_invalid" },
              );
            }
            const finalizer = workflow.nodes.find((node: any) => node.type === "turn-finalize");
            turn.current.workflowNarrativeNodeId = finalizer?.narrative?.fromNode || null;
            const workflowRunId = `workflow-${randomUUID()}`;
            turn.current.workflowRunId = workflowRunId;
            await scope.requireCurrent().workflowEngine.start(workflow, {
              id: workflowRunId,
              cardId: scope.requireCurrent().cardId,
              chatId: scope.requireCurrent().recordId,
              turn: scope.requireCurrent().turn,
              trigger: { type: "player-input" },
              sourceReferences: userRecord ? [messageSourceReference(userRecord)] : [],
              payload: { currentInput: content, userSequence: turn.current.submittedSequence },
            });
          } catch (error) {
            scope.requireCurrent().pending = false;
            turn.current = null;
            throw error;
          }
          },
updateUserSettings: async ({ playerName, description }: { playerName: string; description: string }) => {
            if (!scope.requireCurrent()) throw httpError(409, "This Web page belongs to a closed Pi session. Use the newest Web RP page.");
            if (scope.requireCurrent().openingId && playerName !== scope.requireCurrent().playerName) {
              throw httpError(409, "本会话的玩家名已固定；如需改名，请停止游玩后在项目根目录使用维护流程处理会话资料。");
            }
            scope.requireCurrent().playerName = playerName;
            scope.requireCurrent().playerDescription = description;
            scope.requireCurrent().commonSettings.user.playerName = playerName;
            scope.requireCurrent().commonSettings.user.description = description;
            const existingProfile = scope.requireCurrent().commonSettings.user.savedProfiles.find(profile => profile.name === playerName);
            if (existingProfile) existingProfile.description = description;
            else scope.requireCurrent().commonSettings.user.savedProfiles.push({ name: playerName, description });
            scope.requireCurrent().cardSettings.settings.common = {
              ...(scope.requireCurrent().cardSettings.settings.common as Record<string, unknown> || {}),
              user: structuredClone(scope.requireCurrent().commonSettings.user),
            };
            await writeFile(cardSettingsPath, `${JSON.stringify(scope.requireCurrent().cardSettings, null, 2)}\n`, "utf8");
            await updateMetadata();
            return webSnapshot({ settings: scope.requireCurrent().commonSettings });
          },
deleteUserProfile: async (playerName: string) => {
            if (!scope.requireCurrent()) throw httpError(409, "This Web page belongs to a closed Pi session. Use the newest Web RP page.");
            if (scope.requireCurrent().openingId && playerName === scope.requireCurrent().playerName) {
              throw httpError(409, "游玩中不能删除当前会话的玩家档案；请停止游玩后在项目根目录使用维护流程处理。");
            }
            const { settings, removed, activeChanged } = removeSavedUserProfile(scope.requireCurrent().commonSettings, playerName);
            scope.requireCurrent().commonSettings = settings;
            if (activeChanged) {
              scope.requireCurrent().playerName = settings.user.playerName;
              scope.requireCurrent().playerDescription = settings.user.description;
            }
            scope.requireCurrent().cardSettings.settings.common = {
              ...(scope.requireCurrent().cardSettings.settings.common as Record<string, unknown> || {}),
              user: structuredClone(scope.requireCurrent().commonSettings.user),
            };
            await writeFile(cardSettingsPath, `${JSON.stringify(scope.requireCurrent().cardSettings, null, 2)}\n`, "utf8");
            if (removed.avatar && !settings.user.savedProfiles.some((profile: { avatar?: string }) => profile.avatar === removed.avatar)) {
              await rm(resolveAvatarFile(commonSettingsDirectory, removed.avatar), { force: true }).catch(error => {
                console.warn(`Could not remove deleted player avatar ${removed.avatar}:`, (error as Error).message);
              });
            }
            await updateMetadata();
            return webSnapshot({ settings: scope.requireCurrent().commonSettings, deletedPlayerName: removed.name });
          },
updateSystemSettings: async ({ fontSize }: { fontSize: number }) => {
            if (!scope.requireCurrent()) throw httpError(409, "This Web page belongs to a closed Pi session. Use the newest Web RP page.");
            scope.requireCurrent().commonSettings.system.fontSize = fontSize;
            scope.requireCurrent().cardSettings.settings.common = {
              ...(scope.requireCurrent().cardSettings.settings.common as Record<string, unknown> || {}),
              system: structuredClone(scope.requireCurrent().commonSettings.system),
            };
            await writeFile(cardSettingsPath, `${JSON.stringify(scope.requireCurrent().cardSettings, null, 2)}\n`, "utf8");
            return {
              common: scope.requireCurrent().commonSettings,
              card: scope.requireCurrent().cardSettings,
            };
          }
};
}
