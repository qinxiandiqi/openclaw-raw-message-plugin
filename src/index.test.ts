import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { initDb, insertCapturedMessage, queryMessages, closeDb, batchInsert } from "./db.js";
import { queryAgentMessages } from "./queries.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-source-memory-test-"));
const dbPath = path.join(tmpDir, "test.db");

describe("agent-source-memory", () => {
  beforeAll(() => {
    initDb(dbPath);
  });

  afterAll(() => {
    closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("db", () => {
    it("inserts and queries messages", () => {
      const now = Date.now();
      insertCapturedMessage("test-agent", "agent:test-agent:session1", "entry-1", now, "user", {
        role: "user",
        content: "hello",
      });
      insertCapturedMessage("test-agent", "agent:test-agent:session1", "entry-2", now + 1000, "assistant", {
        role: "assistant",
        content: "hi there",
      });

      const result = queryMessages("test-agent", now - 1000, now + 2000);
      expect(result.messages.length).toBe(2);
      expect(result.sessionCount).toBe(1);
      expect(result.messages[0].role).toBe("user");
      expect(result.messages[1].role).toBe("assistant");
    });

    it("filters by time range", () => {
      const now = Date.now();
      const result = queryMessages("test-agent", now + 5000, now + 10000);
      expect(result.messages.length).toBe(0);
    });

    it("returns empty for unknown agent", () => {
      const result = queryMessages("non-existent-agent", 0, Date.now());
      expect(result.messages.length).toBe(0);
    });
  });

  describe("batchInsert", () => {
    it("batch inserts messages for migration", () => {
      const now = Date.now();
      const count = batchInsert("batch-agent", "agent:batch-agent:session1", [
        { entryId: "e1", ts: now, role: "user", msg: { role: "user", content: "q1" } },
        { entryId: "e2", ts: now + 1000, role: "assistant", msg: { role: "assistant", content: "a1" } },
        { entryId: "e3", ts: now + 2000, role: "user", msg: { role: "user", content: "q2" } },
      ]);
      expect(count).toBe(3);

      const result = queryMessages("batch-agent", now - 1000, now + 3000);
      expect(result.messages.length).toBe(3);
    });

    it("deduplicates on (agentId, entryId) regardless of sessionKey", () => {
      const now = Date.now();
      // Insert with one sessionKey
      batchInsert("batch-agent", "agent:batch-agent:session1", [
        { entryId: "e1", ts: now, role: "user", msg: { role: "user", content: "q1" } },
        { entryId: "e2", ts: now + 1000, role: "assistant", msg: { role: "assistant", content: "a1" } },
        { entryId: "e3", ts: now + 2000, role: "user", msg: { role: "user", content: "q2" } },
      ]);
      // Same entryIds, different sessionKey — should be ignored by UNIQUE(agentId, entryId)
      const count = batchInsert("batch-agent", "agent:batch-agent:different-key", [
        { entryId: "e1", ts: now, role: "user", msg: { role: "user", content: "q1 dup" } },
        { entryId: "e2", ts: now + 1000, role: "assistant", msg: { role: "assistant", content: "a1 dup" } },
      ]);
      expect(count).toBe(0); // All duplicates, ignored

      const result = queryMessages("batch-agent", now - 1000, now + 3000);
      expect(result.messages.length).toBe(3); // Still 3, not 5
    });
  });

  describe("cross-path dedup", () => {
    it("deduplicates between real-time capture and migration", () => {
      const now = Date.now();
      const agentId = "cross-agent";
      const sessionKey = "agent:cross-agent:session1";

      // Simulate real-time capture (onSessionTranscriptUpdate)
      insertCapturedMessage(agentId, sessionKey, "cross-entry-1", now, "user", {
        role: "user",
        content: "hello from real-time",
      });
      insertCapturedMessage(agentId, sessionKey, "cross-entry-2", now + 1000, "assistant", {
        role: "assistant",
        content: "response from real-time",
      });

      // Simulate migration scanning the same messages (same entryIds)
      const migratedCount = batchInsert(agentId, sessionKey, [
        { entryId: "cross-entry-1", ts: now + 100, role: "user", msg: { role: "user", content: "hello from real-time" } },
        { entryId: "cross-entry-2", ts: now + 1100, role: "assistant", msg: { role: "assistant", content: "response from real-time" } },
        { entryId: "cross-entry-3", ts: now + 2000, role: "user", msg: { role: "user", content: "only in migration" } },
      ]);
      expect(migratedCount).toBe(1); // Only entry-3 is new

      const result = queryMessages(agentId, now - 1000, now + 3000);
      expect(result.messages.length).toBe(3); // Not 5
      expect(result.messages[0].role).toBe("user");
      expect(result.messages[2].msg).toEqual({ role: "user", content: "only in migration" });
    });
  });

  describe("queries", () => {
    it("queryAgentMessages returns empty result for non-existent agent", async () => {
      const result = await queryAgentMessages("non-existent-agent-xyz", Date.now() - 86400000, Date.now());

      expect(result.messageCount).toBe(0);
      expect(result.sessionCount).toBe(0);
      expect(result.messages).toEqual([]);
    });
  });
});
