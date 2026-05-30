/**
 * Agent Source Memory Plugin (SQLite-based)
 *
 * Captures agent session messages via api.runtime.events.onSessionTranscriptUpdate
 * and provides time-range query via SQLite.
 */

import { Type } from "typebox";
import { definePluginEntry, type OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { toolPluginMetadataSymbol } from "openclaw/plugin-sdk/tool-plugin";
import { jsonResult } from "openclaw/plugin-sdk/agent-runtime";
import { queryAgentMessages } from "./queries.js";
import { initDb, insertCapturedMessage, finalizeSession, closeDb, resolveDbPath } from "./db.js";
import { migrateExistingSessions } from "./migrate.js";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import path from "node:path";

const queryAgentMessagesTool = {
  label: "Query Agent Messages",
  name: "query_agent_messages",
  description:
    "Query all messages for an agent within a time range. " +
    "Returns messages captured in real-time from all sessions.",
  parameters: Type.Object({
    agentId: Type.String({
      description: "Agent ID (e.g. 'main', 'my-agent')",
    }),
    startTime: Type.Number({
      description: "Start time (Unix timestamp in milliseconds)",
    }),
    endTime: Type.Number({
      description: "End time (Unix timestamp in milliseconds)",
    }),
  }),
  execute: async (_toolCallId: string, params: unknown) => {
    const { agentId, startTime, endTime } = params as {
      agentId: string;
      startTime: number;
      endTime: number;
    };
    const result = await queryAgentMessages(agentId, startTime, endTime);
    return jsonResult({
      sessionCount: result.sessionCount,
      messageCount: result.messageCount,
      messages: result.messages,
    });
  },
};

const metadata = {
  id: "agent-source-memory",
  name: "Agent Source Memory",
  description: "Capture and query agent session messages in real-time",
  activation: { onStartup: true },
  configSchema: { type: "object", properties: {}, additionalProperties: false },
  tools: [
    {
      name: queryAgentMessagesTool.name,
      label: queryAgentMessagesTool.label,
      description: queryAgentMessagesTool.description,
      parameters: queryAgentMessagesTool.parameters as unknown,
    },
  ],
};

function extractAgentIdFromSessionFile(sessionFile: string): string {
  const stateDir = resolveStateDir();
  const agentsDir = path.join(stateDir, "agents");
  const relative = path.relative(agentsDir, sessionFile);
  return relative.split(path.sep)[0] || "main";
}

let unsubscribe: (() => void) | null = null;

const entry = definePluginEntry({
  id: "agent-source-memory",
  name: "Agent Source Memory",
  description: "Capture and query agent session messages in real-time",
  register(api: OpenClawPluginApi) {
    // Initialize DB and register listener on gateway start
    api.on("gateway_start", async () => {
      try {
        initDb(resolveDbPath());

        // Use api.runtime.events — the correct injection path that shares
        // the same module instance as internal emitSessionTranscriptUpdate.
        unsubscribe = api.runtime.events.onSessionTranscriptUpdate((update) => {
          if (!update.messageId || !update.sessionKey || update.message === undefined) {
            return;
          }

          const agentId = (update as { agentId?: string }).agentId
            ?? extractAgentIdFromSessionFile(update.sessionFile);
          const role = (update.message as { role?: string }).role ?? "unknown";

          insertCapturedMessage(
            agentId,
            update.sessionKey,
            update.messageId,
            Date.now(),
            role,
            update.message,
          );
        });

        // Migrate existing sessions (duplicates skipped via INSERT OR IGNORE on entryId)
        const count = await migrateExistingSessions();
        if (count > 0) {
          console.log(`[agent-source-memory] Migrated ${count} session files`);
        }
      } catch (err) {
        console.error("[agent-source-memory] Init/migration failed:", err);
      }
    });

    // Register tool
    api.registerTool({
      name: queryAgentMessagesTool.name,
      label: queryAgentMessagesTool.label,
      description: queryAgentMessagesTool.description,
      parameters: queryAgentMessagesTool.parameters,
      execute: queryAgentMessagesTool.execute,
    });

    // Session lifecycle: mark session as finalized
    api.on("session_end", async (event, ctx) => {
      const sessionKey = event.sessionKey ?? ctx.sessionKey;
      finalizeSession(ctx.agentId ?? "main", sessionKey, event.reason ?? "unknown");
    });

    // Graceful shutdown
    api.on("gateway_stop", async () => {
      if (unsubscribe) {
        unsubscribe();
        unsubscribe = null;
      }
      closeDb();
    });
  },
});

Object.defineProperty(entry, toolPluginMetadataSymbol, {
  value: metadata,
  enumerable: false,
});

export default entry;
