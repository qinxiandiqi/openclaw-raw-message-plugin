/**
 * Raw Message Plugin (SQLite-based)
 *
 * Captures agent session messages via api.runtime.events.onSessionTranscriptUpdate
 * and provides time-range query via SQLite.
 */

import { Type } from "typebox";
import { definePluginEntry, type OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { toolPluginMetadataSymbol } from "openclaw/plugin-sdk/tool-plugin";
import { jsonResult } from "openclaw/plugin-sdk/agent-runtime";
import { queryAgentMessages } from "./queries.js";
import { initDb, insertCapturedMessage, finalizeSession, closeDb, resolveDbPath, deduplicateExistingData } from "./db.js";
import { migrateExistingSessions, buildAllAgentSessionKeyMaps } from "./migrate.js";
import { stripCheckpointSuffix } from "./transcript-filenames.js";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import path from "node:path";
import fs from "node:fs/promises";

const queryAgentMessagesTool = {
  label: "Query Agent Messages",
  name: "query_agent_messages",
  description:
    "Query all messages for an agent within a time range. " +
    "Returns messages captured in real-time from all sessions. " +
    "Each message's `ts` is a Unix timestamp in milliseconds " +
    "(sourced from the message itself when available, otherwise the capture time). " +
    "Returns: { sessionCount, messageCount, messages: [{ ts, role, msg }] } " +
    "where `msg` is the full original LLM message object (role, content, tool_calls, etc.).",
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

const queryAgentMessagesToJsonlTool = {
  label: "Query Agent Messages to JSONL",
  name: "query_agent_messages_to_jsonl",
  description:
    "Query all messages for an agent within a time range and write them to a .jsonl file. " +
    "One event per line, sorted by timestamp ascending. " +
    "Each line is a JSON object with `type: 'message'` (the only event type this plugin persists): " +
    "{ type: 'message', id: entryId, timestamp: ISOString, message: { role, content, ... } }. " +
    "`timestamp` is an ISO 8601 string in the host system's local timezone with a `±HH:MM` offset " +
    "(e.g. 2025-05-27T08:00:00.000+08:00), so the time is directly readable without timezone conversion. " +
    "Existing files at `outputPath` are overwritten; the parent directory is created if missing. " +
    "`outputPath` must be an absolute path. " +
    "Returns: { filePath, messageCount, sessionCount }.",
  parameters: Type.Object({
    agentId: Type.String({
      description: "Agent ID (e.g. 'main', 'my-agent')",
    }),
    startTime: Type.Number({
      description: "Start time (Unix timestamp in milliseconds, inclusive)",
    }),
    endTime: Type.Number({
      description: "End time (Unix timestamp in milliseconds, inclusive)",
    }),
    outputPath: Type.String({
      description:
        "Absolute path to the destination .jsonl file. " +
        "The parent directory will be created if it does not exist. " +
        "Existing files are overwritten.",
    }),
  }),
  execute: async (_toolCallId: string, params: unknown) => {
    const { agentId, startTime, endTime, outputPath } = params as {
      agentId: string;
      startTime: number;
      endTime: number;
      outputPath: string;
    };

    if (!path.isAbsolute(outputPath)) {
      throw new Error(`outputPath must be an absolute path, got: ${outputPath}`);
    }

    const result = await queryAgentMessages(agentId, startTime, endTime);

    let body: string;
    try {
      const lines = result.messages.map((m) =>
        JSON.stringify({
          type: "message",
          id: m.entryId,
          timestamp: localIsoFromMs(m.ts),
          message: m.msg,
        }),
      );
      body = lines.length === 0 ? "" : lines.join("\n") + "\n";
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to serialize messages to JSONL: ${reason}`);
    }

    const dir = path.dirname(outputPath);
    try {
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(outputPath, body, "utf-8");
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to write JSONL to ${outputPath}: ${reason}`);
    }

    return jsonResult({
      filePath: outputPath,
      messageCount: result.messageCount,
      sessionCount: result.sessionCount,
    });
  },
};

const metadata = {
  id: "raw-message",
  name: "Openclaw Raw Message Plugin",
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
    {
      name: queryAgentMessagesToJsonlTool.name,
      label: queryAgentMessagesToJsonlTool.label,
      description: queryAgentMessagesToJsonlTool.description,
      parameters: queryAgentMessagesToJsonlTool.parameters as unknown,
    },
  ],
};

function extractAgentIdFromSessionFile(sessionFile: string): string {
  const stateDir = resolveStateDir();
  const agentsDir = path.join(stateDir, "agents");
  const relative = path.relative(agentsDir, sessionFile);
  return relative.split(path.sep)[0] || "main";
}

/**
 * Format a Unix-millisecond timestamp as an ISO 8601 string in the host system's
 * local timezone, with a `±HH:MM` offset suffix (e.g. "2025-05-27T08:00:00.000+08:00").
 * Avoids forcing LLM readers to convert from UTC back to local time.
 * Zero dependencies; uses `Date.prototype.getTimezoneOffset()`.
 */
function localIsoFromMs(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  // getTimezoneOffset returns minutes WEST of UTC (e.g. CST => -480).
  // We want minutes EAST of UTC, so flip the sign.
  const offsetMin = -d.getTimezoneOffset();
  const sign = offsetMin >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMin);
  const offset = `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `.${pad(d.getMilliseconds(), 3)}${offset}`
  );
}

/**
 * Extract a Unix-millisecond timestamp from an LLM message object.
 * Returns undefined if no recognizable time field is present.
 * Recognized fields: timestamp (ISO string or ms), createdAt, created_at, ts.
 */
function resolveMessageTimestamp(message: unknown): number | undefined {
  if (!message || typeof message !== "object") return undefined;
  const m = message as Record<string, unknown>;
  const candidates = [m.timestamp, m.createdAt, m.created_at, m.ts];
  for (const c of candidates) {
    if (typeof c === "number" && Number.isFinite(c)) return c;
    if (typeof c === "string" && c.trim()) {
      const parsed = new Date(c).getTime();
      if (!Number.isNaN(parsed)) return parsed;
    }
  }
  return undefined;
}

let unsubscribe: (() => void) | null = null;

const entry = definePluginEntry({
  id: "raw-message",
  name: "Openclaw Raw Message Plugin",
  description: "Capture and query agent session messages in real-time",
  register(api: OpenClawPluginApi) {
    // Initialize DB and register listener on gateway start
    api.on("gateway_start", async () => {
      try {
        initDb(resolveDbPath());

        // Build session maps from sessions.json for dedup + migration
        const agentSessionKeyMaps = await buildAllAgentSessionKeyMaps();

        // Fix existing data: update migration-style sessionKeys to logical ones
        // and consolidate the sessions table.
        deduplicateExistingData(agentSessionKeyMaps);

        // Use api.runtime.events — the correct injection path that shares
        // the same module instance as internal emitSessionTranscriptUpdate.
        unsubscribe = api.runtime.events.onSessionTranscriptUpdate((update) => {
          if (!update.messageId || !update.sessionKey || update.message === undefined) {
            return;
          }

          const agentId = (update as { agentId?: string }).agentId
            ?? extractAgentIdFromSessionFile(update.sessionFile);
          const role = (update.message as { role?: string }).role ?? "unknown";
          const ts = resolveMessageTimestamp(update.message) ?? Date.now();

          // Defensive: OpenClaw's emitter currently always sends the base
          // sessionKey (see openclaw/src/sessions/transcript-events.ts — all
          // call sites pass the base key, never a `.checkpoint.<uuid>` form).
          // Strip the suffix anyway so a future emitter change or a sibling
          // plugin that re-emits with a checkpoint key doesn't bypass
          // UNIQUE(agentId, sessionKey, entryId). See openclaw/src/gateway/
          // session-compaction-checkpoints.ts:498 for the canonical pattern
          // (checkpoints are stored under the base canonicalKey).
          const sessionKey = stripCheckpointSuffix(update.sessionKey);

          insertCapturedMessage(
            agentId,
            sessionKey,
            update.messageId,
            ts,
            role,
            update.message,
          );
        });

        // Migrate existing sessions (duplicates skipped via INSERT OR IGNORE on entryId)
        const count = await migrateExistingSessions();
        if (count > 0) {
          console.log(`[raw-message] Migrated ${count} session files`);
        }
      } catch (err) {
        console.error("[raw-message] Init/migration failed:", err);
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

    api.registerTool({
      name: queryAgentMessagesToJsonlTool.name,
      label: queryAgentMessagesToJsonlTool.label,
      description: queryAgentMessagesToJsonlTool.description,
      parameters: queryAgentMessagesToJsonlTool.parameters,
      execute: queryAgentMessagesToJsonlTool.execute,
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
