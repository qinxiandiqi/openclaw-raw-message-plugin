/**
 * One-time script to apply the fix to the real database.
 * Runs schema migration, deduplication, and reports results.
 */
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

const dbPath = path.join(
  process.env.HOME!,
  ".openclaw/raw-message/source-memory.db",
);

console.log(`Database: ${dbPath}`);

const db = new Database(dbPath);
db.pragma("journal_mode = WAL");

// 1. Check current schema
const indexes = db.pragma("index_list(messages)") as Array<{
  name: string;
  unique: number;
  origin: string;
}>;
const hasOldConstraint = indexes.some((idx) => {
  if (idx.unique !== 1 || idx.origin !== "u") return false;
  const cols = (
    db.pragma(`index_info("${idx.name}")`) as Array<{ name: string }>
  ).map((c) => c.name);
  return (
    cols.includes("agentId") &&
    cols.includes("sessionKey") &&
    cols.includes("entryId")
  );
});

if (!hasOldConstraint) {
  console.log("Schema already migrated, skipping.");
} else {
  console.log("Migrating schema to v2...");

  // Count before
  const before = (
    db.prepare("SELECT COUNT(*) as c FROM messages").get() as { c: number }
  ).c;
  console.log(`  Messages before: ${before}`);

  // Rebuild tables
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

  const after = (
    db.prepare("SELECT COUNT(*) as c FROM messages").get() as { c: number }
  ).c;
  console.log(`  Messages after: ${after}`);
  console.log(`  Removed ${before - after} duplicates.`);
}

// 2. Build sessions.json reverse lookup
const agentsDir = path.join(process.env.HOME!, ".openclaw/agents");
const agentMaps = new Map<string, Map<string, string>>();

try {
  for (const agentEntry of fs.readdirSync(agentsDir, { withFileTypes: true })) {
    if (!agentEntry.isDirectory()) continue;
    const sessionsJsonPath = path.join(
      agentsDir,
      agentEntry.name,
      "sessions/sessions.json",
    );
    const map = new Map<string, string>();
    try {
      const raw = fs.readFileSync(sessionsJsonPath, "utf-8");
      const store = JSON.parse(raw) as Record<
        string,
        { sessionId?: string; usageFamilySessionIds?: string[] }
      >;
      for (const [logicalKey, entry] of Object.entries(store)) {
        if (entry.sessionId) map.set(entry.sessionId, logicalKey);
        if (Array.isArray(entry.usageFamilySessionIds)) {
          for (const famId of entry.usageFamilySessionIds) {
            if (!map.has(famId)) map.set(famId, logicalKey);
          }
        }
      }
    } catch {
      // No sessions.json
    }
    if (map.size > 0) {
      agentMaps.set(agentEntry.name, map);
      console.log(
        `  Agent ${agentEntry.name}: ${map.size} sessionId → sessionKey mappings`,
      );
    }
  }
} catch {
  // No agents dir
}

// 3. Update migration-style sessionKeys to logical ones
let updatedMessages = 0;
let mergedSessions = 0;

for (const [agentId, sessionIdToKey] of agentMaps) {
  for (const [sessionId, logicalKey] of sessionIdToKey) {
    const migrationKey = `agent:${agentId}:${sessionId}`;
    if (migrationKey === logicalKey) continue;

    const result = db
      .prepare(
        "UPDATE messages SET sessionKey = ? WHERE agentId = ? AND sessionKey = ?",
      )
      .run(logicalKey, agentId, migrationKey);
    updatedMessages += result.changes;

    // Merge sessions
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

      db.prepare(
        `INSERT INTO sessions (agentId, sessionKey, startTime, endTime, messageCount)
         VALUES (?, ?, ?, ?, 1)
         ON CONFLICT(agentId, sessionKey) DO UPDATE SET endTime=?, messageCount=messageCount+1`,
      ).run(agentId, logicalKey, mergedStart, mergedEnd, mergedEnd);

      db.prepare("DELETE FROM sessions WHERE agentId=? AND sessionKey=?").run(
        agentId,
        migrationKey,
      );
      mergedSessions++;
    }
  }

  // Recalculate messageCount for all sessions of this agent
  const rows = db
    .prepare("SELECT sessionKey FROM sessions WHERE agentId=?")
    .all(agentId) as Array<{ sessionKey: string }>;
  for (const row of rows) {
    db.prepare(
      "UPDATE sessions SET messageCount = (SELECT COUNT(*) FROM messages WHERE agentId=? AND sessionKey=?) WHERE agentId=? AND sessionKey=?",
    ).run(agentId, row.sessionKey, agentId, row.sessionKey);
  }
}

console.log(`Updated ${updatedMessages} messages to logical sessionKeys.`);
console.log(`Merged ${mergedSessions} session rows.`);

// 4. Final verification
const finalCount = (
  db.prepare("SELECT COUNT(*) as c FROM messages").get() as { c: number }
).c;
const distinctEntryIds = (
  db.prepare("SELECT COUNT(DISTINCT entryId) as c FROM messages").get() as {
    c: number;
  }
).c;
const dupes = (
  db
    .prepare(
      "SELECT COUNT(*) as c FROM (SELECT entryId FROM messages GROUP BY entryId HAVING COUNT(*) > 1)",
    )
    .get() as { c: number }
).c;

console.log("\n=== Final verification ===");
console.log(`Total messages: ${finalCount}`);
console.log(`Distinct entryIds: ${distinctEntryIds}`);
console.log(`Duplicate entryIds: ${dupes}`);
console.log(
  `Session rows: ${(db.prepare("SELECT COUNT(*) as c FROM sessions").get() as { c: number }).c}`,
);

// Show new schema
console.log("\nSchema:");
for (const idx of db.pragma("index_list(messages)") as Array<{
  name: string;
  unique: number;
  origin: string;
}>) {
  if (idx.unique) {
    const cols = (
      db.pragma(`index_info("${idx.name}")`) as Array<{ name: string }>
    ).map((c) => c.name);
    console.log(`  UNIQUE: ${cols.join(", ")}`);
  }
}

db.close();
