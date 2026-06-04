/**
 * SQLite database layer for raw-message plugin.
 *
 * Provides entryId-keyed writes for both real-time capture
 * (via onSessionTranscriptUpdate) and migration scanning,
 * with cross-path dedup via UNIQUE(agentId, entryId).
 *
 * Schema v2: UNIQUE(agentId, entryId) — sessionKey is kept for
 * attribution but no longer participates in the dedup constraint.
 * sessionKey may be empty ("") for migration entries where the
 * logical sessionKey could not be resolved from sessions.json.
 */

import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";

const PLUGIN_DATA_DIR = "raw-message";
const LEGACY_DATA_DIR = "agent-source-memory";
const DB_FILENAME = "source-memory.db";

/** Schema v2: UNIQUE(agentId, entryId) instead of (agentId, sessionKey, entryId). */
const SCHEMA_V2_SQL = `
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agentId TEXT NOT NULL,
  sessionKey TEXT NOT NULL DEFAULT '',
  entryId TEXT NOT NULL,
  ts INTEGER NOT NULL,
  role TEXT NOT NULL,
  msg TEXT NOT NULL,
  UNIQUE(agentId, entryId)
);
CREATE INDEX IF NOT EXISTS idx_messages_agent_ts ON messages(agentId, ts);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(agentId, sessionKey);

CREATE TABLE IF NOT EXISTS sessions (
  agentId TEXT NOT NULL,
  sessionKey TEXT NOT NULL DEFAULT '',
  startTime INTEGER,
  endTime INTEGER,
  messageCount INTEGER DEFAULT 0,
  finalized INTEGER DEFAULT 0,
  endReason TEXT,
  PRIMARY KEY(agentId, sessionKey)
);
`;

let db: Database.Database | null = null;
let insertMsgStmt: Database.Statement | null = null;
let upsertSessionStmt: Database.Statement | null = null;
let finalizeSessionStmt: Database.Statement | null = null;

export function resolveDbPath(): string {
  const stateDir = resolveStateDir();
  const newDir = path.join(stateDir, PLUGIN_DATA_DIR);
  const legacyDir = path.join(stateDir, LEGACY_DATA_DIR);

  // Auto-migrate: if new dir doesn't exist but legacy dir does, rename it
  if (!fs.existsSync(newDir) && fs.existsSync(legacyDir)) {
    try {
      fs.renameSync(legacyDir, newDir);
      console.log(`[raw-message] Migrated data directory: ${legacyDir} → ${newDir}`);
    } catch (err) {
      // Rename failed (e.g. cross-device link) — fall back to using legacy dir
      console.warn(`[raw-message] Could not rename ${legacyDir} → ${newDir}:`, err);
      fs.mkdirSync(newDir, { recursive: true });
    }
  }

  fs.mkdirSync(newDir, { recursive: true });
  return path.join(newDir, DB_FILENAME);
}

/**
 * Detect whether the existing messages table uses the old v1 schema
 * with UNIQUE(agentId, sessionKey, entryId).
 */
function needsSchemaMigration(db: Database.Database): boolean {
  const indexes = db.pragma("index_list(messages)") as Array<{
    name: string;
    unique: number;
    origin: string;
  }>;
  for (const idx of indexes) {
    if (idx.unique !== 1 || idx.origin !== "c") continue;
    const cols = (
      db.pragma(`index_info("${idx.name}")`) as Array<{ name: string }>
    ).map((c) => c.name);
    if (
      cols.includes("agentId") &&
      cols.includes("sessionKey") &&
      cols.includes("entryId")
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Migrate from v1 (UNIQUE agentId, sessionKey, entryId) to v2 (UNIQUE agentId, entryId).
 * SQLite doesn't support ALTER CONSTRAINT — rebuild via create-copy-drop-rename.
 * INSERT OR IGNORE during copy automatically deduplicates on the new constraint.
 */
function migrateSchemaV2(db: Database.Database): void {
  console.log(
    "[raw-message] Migrating schema to v2 (UNIQUE(agentId, entryId))...",
  );

  db.exec(`
    CREATE TABLE IF NOT EXISTS messages_v2 (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agentId TEXT NOT NULL,
      sessionKey TEXT NOT NULL DEFAULT '',
      entryId TEXT NOT NULL,
      ts INTEGER NOT NULL,
      role TEXT NOT NULL,
      msg TEXT NOT NULL,
      UNIQUE(agentId, entryId)
    );
    INSERT OR IGNORE INTO messages_v2 (agentId, sessionKey, entryId, ts, role, msg)
      SELECT agentId, sessionKey, entryId, ts, role, msg FROM messages;
    DROP TABLE messages;
    ALTER TABLE messages_v2 RENAME TO messages;

    CREATE INDEX IF NOT EXISTS idx_messages_agent_ts ON messages(agentId, ts);
    CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(agentId, sessionKey);
  `);

  // sessions table: keep structure, but ensure DEFAULT '' on sessionKey
  // by rebuilding it too.
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions_v2 (
      agentId TEXT NOT NULL,
      sessionKey TEXT NOT NULL DEFAULT '',
      startTime INTEGER,
      endTime INTEGER,
      messageCount INTEGER DEFAULT 0,
      finalized INTEGER DEFAULT 0,
      endReason TEXT,
      PRIMARY KEY(agentId, sessionKey)
    );
    INSERT OR REPLACE INTO sessions_v2 SELECT * FROM sessions;
    DROP TABLE sessions;
    ALTER TABLE sessions_v2 RENAME TO sessions;
  `);

  console.log("[raw-message] Schema migration to v2 complete.");
}

export function initDb(dbPath?: string): void {
  if (db) return;

  const p = dbPath ?? resolveDbPath();
  db = new Database(p);
  db.pragma("journal_mode = WAL");

  // Check if this is a fresh DB or existing.
  const tableCheck = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='messages'",
    )
    .get();

  if (tableCheck) {
    // Existing DB — check if schema migration is needed.
    if (needsSchemaMigration(db)) {
      migrateSchemaV2(db);
    }
  } else {
    // Fresh DB — use v2 schema directly.
    db.exec(SCHEMA_V2_SQL);
  }

  insertMsgStmt = db.prepare(
    "INSERT OR IGNORE INTO messages (agentId, sessionKey, entryId, ts, role, msg) VALUES (?, ?, ?, ?, ?, ?)",
  );
  upsertSessionStmt = db.prepare(
    `INSERT INTO sessions (agentId, sessionKey, startTime, endTime, messageCount)
     VALUES (?, ?, ?, ?, 1)
     ON CONFLICT(agentId, sessionKey) DO UPDATE SET endTime=?, messageCount=messageCount+1`,
  );
  finalizeSessionStmt = db.prepare(
    "UPDATE sessions SET finalized=1, endReason=? WHERE agentId=? AND sessionKey=?",
  );
}

/** Insert a message captured via onSessionTranscriptUpdate. */
export function insertCapturedMessage(
  agentId: string,
  sessionKey: string,
  entryId: string,
  ts: number,
  role: string,
  msg: unknown,
): void {
  if (!db || !insertMsgStmt || !upsertSessionStmt) return;

  insertMsgStmt.run(agentId, sessionKey, entryId, ts, role, JSON.stringify(msg));
  upsertSessionStmt.run(agentId, sessionKey, ts, ts, ts);
}

/** Mark a session as finalized. Called from session_end (async hook). */
export function finalizeSession(
  agentId: string,
  sessionKey: string | undefined,
  reason: string,
): void {
  if (!db || !finalizeSessionStmt) return;

  const key = sessionKey ?? `agent:${agentId ?? "main"}:unknown`;
  const safeAgentId = agentId ?? "main";
  finalizeSessionStmt.run(reason, safeAgentId, key);
}

/** Batch-insert messages (for migration). Uses a transaction. */
export function batchInsert(
  agentId: string,
  sessionKey: string,
  entries: Array<{ entryId: string; ts: number; role: string; msg: unknown }>,
): number {
  if (!db || !insertMsgStmt || !upsertSessionStmt) return 0;

  const insertMany = db.transaction((items: typeof entries) => {
    let count = 0;
    for (const item of items) {
      if (!item.entryId) continue;
      try {
        const result = insertMsgStmt!.run(
          agentId,
          sessionKey,
          item.entryId,
          item.ts,
          item.role,
          JSON.stringify(item.msg),
        );
        if (result.changes > 0) count++;
      } catch {
        // Invalid — skip
      }
    }
    if (count > 0) {
      const firstTs = items[0].ts;
      const lastTs = items[items.length - 1].ts;
      upsertSessionStmt!.run(agentId, sessionKey, firstTs, lastTs, lastTs);
    }
    return count;
  });

  return insertMany(entries);
}

/**
 * One-time cleanup: update migration-style sessionKeys to logical ones
 * and consolidate the sessions table.
 *
 * For each agent, looks up the reverse map (sessionId → logical sessionKey)
 * and updates messages/sessions that were stored under migration-style keys
 * (e.g. "agent:main:853fdc7e-...") to their logical sessionKey.
 *
 * After consolidation, messageCount is recalculated from the messages table
 * and startTime/endTime are merged as MIN/MAX across all source rows.
 */
export function deduplicateExistingData(
  agentSessionKeyMaps: Map<string, Map<string, string>>,
): void {
  if (!db) return;

  for (const [agentId, sessionIdToKey] of agentSessionKeyMaps) {
    for (const [sessionId, logicalKey] of sessionIdToKey) {
      const migrationKey = `agent:${agentId}:${sessionId}`;
      if (migrationKey === logicalKey) continue;

      // 1. Update messages from migration-style key to logical key
      db.prepare(
        "UPDATE messages SET sessionKey = ? WHERE agentId = ? AND sessionKey = ?",
      ).run(logicalKey, agentId, migrationKey);

      // 2. Consolidate sessions: merge migration-keyed row into logical-keyed row
      const migRow = db
        .prepare(
          "SELECT messageCount, startTime, endTime FROM sessions WHERE agentId=? AND sessionKey=?",
        )
        .get(agentId, migrationKey) as
        | { messageCount: number; startTime: number; endTime: number }
        | undefined;

      if (migRow) {
        const existingRow = db
          .prepare(
            "SELECT startTime, endTime FROM sessions WHERE agentId=? AND sessionKey=?",
          )
          .get(agentId, logicalKey) as
          | { startTime: number; endTime: number }
          | undefined;

        const mergedStart = existingRow
          ? Math.min(existingRow.startTime ?? migRow.startTime, migRow.startTime)
          : migRow.startTime;
        const mergedEnd = existingRow
          ? Math.max(existingRow.endTime ?? migRow.endTime, migRow.endTime)
          : migRow.endTime;

        // Upsert into logical session with merged time range
        upsertSessionStmt!.run(agentId, logicalKey, mergedStart, mergedEnd, mergedEnd);

        // Delete migration-keyed session row
        db.prepare("DELETE FROM sessions WHERE agentId=? AND sessionKey=?").run(
          agentId,
          migrationKey,
        );
      }
    }

    // 3. Recalculate messageCount from messages table for all logical keys of this agent
    const rows = db
      .prepare("SELECT sessionKey FROM sessions WHERE agentId=?")
      .all(agentId) as Array<{ sessionKey: string }>;
    const updateCount = db.prepare(
      "UPDATE sessions SET messageCount = (SELECT COUNT(*) FROM messages WHERE agentId=? AND sessionKey=?) WHERE agentId=? AND sessionKey=?",
    );
    for (const row of rows) {
      updateCount.run(agentId, row.sessionKey, agentId, row.sessionKey);
    }
  }
}

/** Query messages by agent and time range. */
export function queryMessages(
  agentId: string,
  startTime: number,
  endTime: number,
): { messages: Array<{ entryId: string; ts: number; role: string; msg: unknown }>; sessionCount: number } {
  if (!db) return { messages: [], sessionCount: 0 };

  const rows = db
    .prepare(
      "SELECT entryId, ts, role, msg FROM messages WHERE agentId=? AND ts BETWEEN ? AND ? ORDER BY ts",
    )
    .all(agentId, startTime, endTime) as Array<{ entryId: string; ts: number; role: string; msg: string }>;

  const sessionKeys = new Set(
    (
      db
        .prepare(
          "SELECT DISTINCT sessionKey FROM messages WHERE agentId=? AND ts BETWEEN ? AND ?",
        )
        .all(agentId, startTime, endTime) as Array<{ sessionKey: string }>
    ).map((r) => r.sessionKey),
  );

  return {
    messages: rows.map((r) => ({ entryId: r.entryId, ts: r.ts, role: r.role, msg: JSON.parse(r.msg) })),
    sessionCount: sessionKeys.size,
  };
}

/** Close the database. */
export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
    insertMsgStmt = null;
    upsertSessionStmt = null;
    finalizeSessionStmt = null;
  }
}
