/**
 * Session migration for agent-source-memory (SQLite-based)
 *
 * Scans existing session .jsonl files and imports them into SQLite.
 * Runs incrementally on gateway_start.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import { batchInsert } from "./db.js";
import { normalizeSessionTranscriptFileName } from "./transcript-filenames.js";

interface ExtractedMessage {
  entryId: string;
  ts: number;
  role: string;
  msg: unknown;
}

async function extractMessagesFromSessionFile(filepath: string): Promise<ExtractedMessage[]> {
  const content = await fs.readFile(filepath, "utf-8");
  const lines = content.split("\n").filter(Boolean);
  const messages: ExtractedMessage[] = [];

  for (const line of lines) {
    try {
      const event = JSON.parse(line);
      if (event.type !== "message" || !event.message) continue;

      const ts = event.timestamp ? new Date(event.timestamp).getTime() : Date.now();
      const entryId = typeof event.id === "string" && event.id.trim() ? event.id : undefined;
      if (!entryId) continue;
      messages.push({
        entryId,
        ts,
        role: event.message.role ?? "unknown",
        msg: event.message,
      });
    } catch {
      // Skip invalid lines
    }
  }

  return messages;
}

export async function migrateExistingSessions(): Promise<number> {
  const agentsDir = path.join(resolveStateDir(), "agents");
  let totalMigrated = 0;

  try {
    const agentEntries = await fs.readdir(agentsDir, { withFileTypes: true });

    for (const agentEntry of agentEntries) {
      if (!agentEntry.isDirectory()) continue;
      totalMigrated += await migrateAgentSessions(agentEntry.name);
    }
  } catch {
    // agents dir doesn't exist
  }

  return totalMigrated;
}

async function migrateAgentSessions(agentId: string): Promise<number> {
  const sessionsDir = path.join(resolveStateDir(), "agents", agentId, "sessions");
  let migratedCount = 0;

  try {
    const entries = await fs.readdir(sessionsDir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isFile()) continue;

      // Normalize filename to base sessionId. Checkpoint (.checkpoint.<uuid>.jsonl)
      // and archive (.jsonl.reset.<iso> / .jsonl.deleted.<ts> / .jsonl.bak-<n>)
      // variants all collapse to the same base sessionKey so UNIQUE(agentId,
      // sessionKey, entryId) actually dedupes across them. Returns null for
      // trajectory / pointer / temp / store files — those are not session
      // transcripts and must be skipped.
      const sessionId = normalizeSessionTranscriptFileName(entry.name);
      if (sessionId === null) continue;
      const sessionKey = `agent:${agentId}:${sessionId}`;

      const filepath = path.join(sessionsDir, entry.name);
      const messages = await extractMessagesFromSessionFile(filepath);
      if (messages.length === 0) continue;

      const count = batchInsert(agentId, sessionKey, messages);
      if (count > 0) migratedCount++;
    }
  } catch {
    // Directory doesn't exist or permission error
  }

  return migratedCount;
}
