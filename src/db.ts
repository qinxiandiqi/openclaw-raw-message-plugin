/**
 * SQLite database layer for agent-source-memory.
 *
 * Provides entryId-keyed writes for both real-time capture
 * (via onSessionTranscriptUpdate) and migration scanning,
 * with cross-path dedup via UNIQUE(agentId, sessionKey, entryId).
 */

import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";

const PLUGIN_DATA_DIR = "agent-source-memory";
const DB_FILENAME = "source-memory.db";

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agentId TEXT NOT NULL,
  sessionKey TEXT NOT NULL,
  entryId TEXT NOT NULL,
  ts INTEGER NOT NULL,
  role TEXT NOT NULL,
  msg TEXT NOT NULL,
  UNIQUE(agentId, sessionKey, entryId)
);
CREATE INDEX IF NOT EXISTS idx_messages_agent_ts ON messages(agentId, ts);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(agentId, sessionKey);

CREATE TABLE IF NOT EXISTS sessions (
  agentId TEXT NOT NULL,
  sessionKey TEXT NOT NULL,
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
  const dir = path.join(resolveStateDir(), PLUGIN_DATA_DIR);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, DB_FILENAME);
}

export function initDb(dbPath?: string): void {
  if (db) return;

  const p = dbPath ?? resolveDbPath();
  db = new Database(p);
  db.pragma("journal_mode = WAL");
  db.exec(SCHEMA_SQL);

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
