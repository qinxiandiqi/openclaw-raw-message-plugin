/**
 * Session migration for raw-message plugin (SQLite-based)
 *
 * Scans existing session .jsonl files and imports them into SQLite.
 * Runs incrementally on gateway_start.
 *
 * Uses sessions.json to resolve the logical sessionKey from the
 * physical sessionId found in .jsonl filenames. If the mapping
 * is not available (session was recycled), sessionKey is set to ""
 * and UNIQUE(agentId, entryId) still prevents duplicates.
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

interface SessionStoreEntry {
  sessionId?: string;
  usageFamilySessionIds?: string[];
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

/**
 * Build a reverse-lookup map from physical sessionId to logical sessionKey,
 * using the sessions.json store for the given agent.
 *
 * sessions.json is a Record<sessionKey, SessionEntry> where:
 *   - keys are logical sessionKeys (e.g. "agent:main:feishu:direct:ou_xxx")
 *   - values have .sessionId (current physical ID) and optionally
 *     .usageFamilySessionIds (array of all historical physical sessionIds)
 */
async function buildSessionIdToKeyMap(
  agentId: string,
): Promise<Map<string, string>> {
  const sessionsJsonPath = path.join(
    resolveStateDir(),
    "agents",
    agentId,
    "sessions",
    "sessions.json",
  );
  const map = new Map<string, string>();

  try {
    const raw = await fs.readFile(sessionsJsonPath, "utf-8");
    const store = JSON.parse(raw) as Record<string, SessionStoreEntry>;

    for (const [logicalKey, entry] of Object.entries(store)) {
      // Current sessionId for this logical session
      if (entry.sessionId) {
        map.set(entry.sessionId, logicalKey);
      }
      // Historical sessionIds (from previous rotations/resets)
      if (Array.isArray(entry.usageFamilySessionIds)) {
        for (const famId of entry.usageFamilySessionIds) {
          // Only set if not already mapped (first logicalKey wins)
          if (!map.has(famId)) {
            map.set(famId, logicalKey);
          }
        }
      }
    }
  } catch {
    // sessions.json doesn't exist or is unreadable — map stays empty.
    // All sessionKeys will be empty string.
  }

  return map;
}

/**
 * Build reverse-lookup maps for all agents.
 * Returns Map<agentId, Map<sessionId, logicalSessionKey>>.
 */
export async function buildAllAgentSessionKeyMaps(): Promise<
  Map<string, Map<string, string>>
> {
  const agentsDir = path.join(resolveStateDir(), "agents");
  const result = new Map<string, Map<string, string>>();

  try {
    const agentEntries = await fs.readdir(agentsDir, { withFileTypes: true });
    for (const agentEntry of agentEntries) {
      if (!agentEntry.isDirectory()) continue;
      const map = await buildSessionIdToKeyMap(agentEntry.name);
      if (map.size > 0) {
        result.set(agentEntry.name, map);
      }
    }
  } catch {
    // agents dir doesn't exist
  }

  return result;
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

async function migrateAgentSessions(
  agentId: string,
  sessionIdToKey?: Map<string, string>,
): Promise<number> {
  const sessionsDir = path.join(resolveStateDir(), "agents", agentId, "sessions");
  let migratedCount = 0;

  // Build reverse lookup if not provided by caller
  const lookup = sessionIdToKey ?? (await buildSessionIdToKeyMap(agentId));

  try {
    const entries = await fs.readdir(sessionsDir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isFile()) continue;

      const sessionId = normalizeSessionTranscriptFileName(entry.name);
      if (sessionId === null) continue;

      // Use logical sessionKey from sessions.json if available,
      // otherwise empty string. UNIQUE(agentId, entryId) still prevents
      // duplicates for unmapped sessions.
      const sessionKey = lookup.get(sessionId) ?? "";

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
