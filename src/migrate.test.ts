/**
 * Regression tests for migrate.ts sessionKey normalization and sessions.json lookup.
 *
 * These tests guard against the bug where checkpoint / reset / deleted
 * session-file variants were each treated as independent sessions,
 * causing the same entryIds to be written under multiple sessionKeys
 * and bypassing UNIQUE(agentId, entryId).
 */

import { describe, expect, it, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { initDb, queryMessages, closeDb, insertCapturedMessage } from "./db.js";
import { migrateExistingSessions, buildAllAgentSessionKeyMaps } from "./migrate.js";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-source-memory-migrate-"));
const originalStateDir = process.env.OPENCLAW_STATE_DIR;

function writeSessionFile(agentId: string, filename: string, lines: string[]): void {
  const dir = path.join(tmpDir, "agents", agentId, "sessions");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, filename), lines.join("\n") + "\n", "utf-8");
}

function writeSessionsJson(agentId: string, data: Record<string, unknown>): void {
  const dir = path.join(tmpDir, "agents", agentId, "sessions");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "sessions.json"), JSON.stringify(data, null, 2), "utf-8");
}

function makeLine(id: string, role: "user" | "assistant" | "toolResult", text: string): string {
  return JSON.stringify({
    type: "message",
    id,
    timestamp: new Date().toISOString(),
    message: { role, content: [{ type: "text", text }] },
  });
}

// Single shared lifecycle for all describe blocks in this file.
beforeAll(() => {
  process.env.OPENCLAW_STATE_DIR = tmpDir;
  initDb();
});

afterAll(() => {
  closeDb();
  if (originalStateDir === undefined) {
    delete process.env.OPENCLAW_STATE_DIR;
  } else {
    process.env.OPENCLAW_STATE_DIR = originalStateDir;
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("migrate", () => {
  it("imports a plain session file under the base sessionKey", async () => {
    const baseId = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
    writeSessionFile(
      "test-plain",
      `${baseId}.jsonl`,
      [makeLine("p1", "user", "hi"), makeLine("p2", "assistant", "hello")],
    );
    await migrateExistingSessions();

    const result = queryMessages("test-plain", 0, Date.now() + 1000);
    expect(result.messages.length).toBe(2);
    expect(result.sessionCount).toBe(1);
  });

  it("imports a checkpoint file under the BASE sessionKey (not the checkpoint one)", async () => {
    const baseId = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
    const cpId = "11111111-1111-4111-8111-111111111111";
    writeSessionFile(
      "test-cp",
      `${baseId}.checkpoint.${cpId}.jsonl`,
      [makeLine("c1", "user", "from cp"), makeLine("c2", "assistant", "in cp")],
    );
    await migrateExistingSessions();

    const result = queryMessages("test-cp", 0, Date.now() + 1000);
    // Both messages imported under base sessionKey
    expect(result.messages.length).toBe(2);
    expect(result.sessionCount).toBe(1);
  });

  it("dedupes plain + checkpoint files of the SAME base (UNIQUE across variants)", async () => {
    const baseId = "cccccccc-3333-4333-8333-cccccccccccc";
    const cpId = "22222222-2222-4222-8222-222222222222";
    // Same message id appears in both files
    writeSessionFile(
      "test-dedup",
      `${baseId}.jsonl`,
      [makeLine("d1", "user", "shared"), makeLine("d2", "assistant", "plain-only")],
    );
    writeSessionFile(
      "test-dedup",
      `${baseId}.checkpoint.${cpId}.jsonl`,
      [makeLine("d1", "user", "shared"), makeLine("d3", "user", "cp-only")],
    );
    await migrateExistingSessions();

    // Without normalization, d1 would appear twice (once per file, under
    // different sessionKeys). After the fix, both files collapse to the
    // same base sessionKey and UNIQUE keeps one copy of d1.
    const result = queryMessages("test-dedup", 0, Date.now() + 1000);
    const ids = result.messages.map((m) => m.entryId);
    expect(ids.filter((id) => id === "d1").length).toBe(1);
    // Total distinct ids: d1, d2, d3
    expect(result.messages.length).toBe(3);
    expect(result.sessionCount).toBe(1);
  });

  it("imports reset / deleted archive files under the BASE sessionKey", async () => {
    const baseId = "dddddddd-4444-4444-8444-dddddddddddd";
    writeSessionFile(
      "test-archive",
      `${baseId}.jsonl.reset.2026-05-01T00-00-00.000Z`,
      [makeLine("r1", "user", "from reset")],
    );
    writeSessionFile(
      "test-archive",
      `${baseId}.jsonl.deleted.1780167611136`,
      [makeLine("dl1", "assistant", "from deleted")],
    );
    await migrateExistingSessions();

    const result = queryMessages("test-archive", 0, Date.now() + 1000);
    expect(result.messages.length).toBe(2);
    expect(result.sessionCount).toBe(1);
  });

  it("skips trajectory runtime files", async () => {
    const baseId = "eeeeeeee-5555-4555-8555-eeeeeeeeeeee";
    writeSessionFile(
      "test-traj",
      `${baseId}.trajectory.jsonl`,
      [makeLine("t1", "user", "should not be imported")],
    );
    await migrateExistingSessions();

    const result = queryMessages("test-traj", 0, Date.now() + 1000);
    expect(result.messages.length).toBe(0);
  });

  it("skips trajectory pointer files", async () => {
    const baseId = "ffffffff-6666-4666-8666-ffffffffffff";
    fs.mkdirSync(path.join(tmpDir, "agents", "test-pointer", "sessions"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, "agents", "test-pointer", "sessions", `${baseId}.trajectory-path.json`),
      "{}",
      "utf-8",
    );
    await migrateExistingSessions();

    const result = queryMessages("test-pointer", 0, Date.now() + 1000);
    expect(result.messages.length).toBe(0);
  });
});

describe("sessions.json reverse lookup", () => {
  it("resolves sessionId to logical sessionKey via sessions.json", async () => {
    const agentId = "test-lookup";
    const sessionId = "aaaa1111-2222-3333-4444-aaaa11112222";
    const logicalKey = `agent:${agentId}:feishu:direct:ou_test123`;

    writeSessionsJson(agentId, {
      [logicalKey]: { sessionId, usageFamilySessionIds: [] },
    });

    writeSessionFile(
      agentId,
      `${sessionId}.jsonl`,
      [makeLine("lk1", "user", "lookup test")],
    );

    await migrateExistingSessions();

    const result = queryMessages(agentId, 0, Date.now() + 1000);
    expect(result.messages.length).toBe(1);
    // Both realtime and migration sessionKeys resolve to the same logical key
    expect(result.sessionCount).toBe(1);
  });

  it("resolves sessionId found in usageFamilySessionIds", async () => {
    const agentId = "test-family";
    const currentSessionId = "bbbb1111-2222-3333-4444-bbbb11112222";
    const oldSessionId = "cccc1111-2222-3333-4444-cccc11112222";
    const logicalKey = `agent:${agentId}:feishu:direct:ou_family`;

    writeSessionsJson(agentId, {
      [logicalKey]: { sessionId: currentSessionId, usageFamilySessionIds: [oldSessionId] },
    });

    // Write old session file — should map to the same logical key
    writeSessionFile(
      agentId,
      `${oldSessionId}.jsonl`,
      [makeLine("fam1", "user", "from old session")],
    );
    // Write current session file — should also map to the same logical key
    writeSessionFile(
      agentId,
      `${currentSessionId}.jsonl`,
      [makeLine("fam2", "user", "from current session")],
    );

    await migrateExistingSessions();

    const result = queryMessages(agentId, 0, Date.now() + 1000);
    expect(result.messages.length).toBe(2);
    expect(result.sessionCount).toBe(1); // Both under the same logical sessionKey
  });

  it("uses empty sessionKey when sessionId not found in sessions.json", async () => {
    const agentId = "test-unmapped";
    const sessionId = "dddd1111-2222-3333-4444-dddd11112222";

    // No sessions.json written for this agent

    writeSessionFile(
      agentId,
      `${sessionId}.jsonl`,
      [makeLine("unm1", "user", "unmapped session")],
    );

    await migrateExistingSessions();

    const result = queryMessages(agentId, 0, Date.now() + 1000);
    expect(result.messages.length).toBe(1);
    // Message stored with empty sessionKey — UNIQUE(agentId, entryId) still works
  });

  it("dedupes between real-time capture (logical key) and migration (mapped from sessionId)", async () => {
    const agentId = "test-dedup-lookup";
    const sessionId = "eeee1111-2222-3333-4444-eeee11112222";
    const logicalKey = `agent:${agentId}:feishu:direct:ou_dedup`;

    writeSessionsJson(agentId, {
      [logicalKey]: { sessionId },
    });

    // Simulate real-time capture (already inserted with logical key)
    insertCapturedMessage(agentId, logicalKey, "dedup-1", Date.now(), "user", {
      role: "user",
      content: "from real-time",
    });

    // Simulate migration (same entryId, should be ignored)
    writeSessionFile(
      agentId,
      `${sessionId}.jsonl`,
      [makeLine("dedup-1", "user", "from migration")],
    );

    await migrateExistingSessions();

    const result = queryMessages(agentId, 0, Date.now() + 1000);
    expect(result.messages.length).toBe(1);
  });

  it("buildAllAgentSessionKeyMaps reads sessions.json for all agents", async () => {
    const agentId = "test-build-maps";
    const sessionId = "ffff1111-2222-3333-4444-ffff11112222";
    const logicalKey = `agent:${agentId}:feishu:direct:ou_maps`;

    writeSessionsJson(agentId, {
      [logicalKey]: { sessionId },
    });

    const maps = await buildAllAgentSessionKeyMaps();
    const agentMap = maps.get(agentId);
    expect(agentMap).toBeDefined();
    expect(agentMap!.get(sessionId)).toBe(logicalKey);
  });
});
