/**
 * Session migration for agent-source-memory
 *
 * Scans existing session files and imports them into snapshots.
 * Handles main sessions, deleted snapshots, reset snapshots, and backups.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import { saveCompactionSnapshot, getSnapshotIndex } from "./snapshot.js";
import type { SessionMessage } from "./types.js";

/**
 * 从 .jsonl 文件提取消息
 */
async function extractMessagesFromSessionFile(filepath: string): Promise<SessionMessage[]> {
  const content = await fs.readFile(filepath, "utf-8");
  const lines = content.split("\n").filter(Boolean);
  const messages: SessionMessage[] = [];

  for (const line of lines) {
    try {
      const event = JSON.parse(line);
      if (event.type !== "message" || !event.message) continue;

      // 保留原始 content 数组（包含 text 和 thinking）
      const originalContent = event.message.content ?? null;

      messages.push({
        id: event.id,
        parentId: event.parentId ?? null,
        role: event.message.role,
        content: originalContent,
        timestamp: event.timestamp ? new Date(event.timestamp).getTime() : undefined,
      });
    } catch {
      // 跳过无效行
    }
  }

  return messages;
}

/**
 * 扫描并迁移所有 agent 的 session 文件
 * @returns 新增快照数量
 */
export async function migrateExistingSessions(): Promise<number> {
  const agentsDir = path.join(resolveStateDir(), "agents");
  let totalMigrated = 0;

  try {
    const agentEntries = await fs.readdir(agentsDir, { withFileTypes: true });

    for (const agentEntry of agentEntries) {
      if (!agentEntry.isDirectory()) continue;

      const agentId = agentEntry.name;
      const migrated = await migrateAgentSessions(agentId);
      totalMigrated += migrated;
    }
  } catch {
    // agents 目录不存在
  }

  return totalMigrated;
}

/**
 * 增量迁移单个 agent 的现有 session 文件
 * @returns 新增快照数量
 */
export async function migrateAgentSessions(agentId: string): Promise<number> {
  const sessionsDir = path.join(resolveStateDir(), "agents", agentId, "sessions");
  const existingIndex = await getSnapshotIndex(agentId);
  // 使用 filepath 作为 key 来跟踪已收录的文件
  const existingFilepaths = new Set(existingIndex.map((s) => s.filepath));

  let migratedCount = 0;

  try {
    const entries = await fs.readdir(sessionsDir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isFile()) continue;

      // 只处理 .jsonl 相关文件
      if (!entry.name.endsWith(".jsonl")) continue;

      const filepath = path.join(sessionsDir, entry.name);

      // 跳过已收录的
      if (existingFilepaths.has(filepath)) continue;

      const messages = await extractMessagesFromSessionFile(filepath);

      if (messages.length === 0) continue;

      // 从文件名提取 sessionId（去掉 .jsonl 及后续的变体后缀）
      // 例如: "abc123.jsonl.deleted.12345" -> "abc123"
      const sessionId = entry.name.replace(/\.jsonl(\..+)?$/, "");

      // 构建 sessionKey（假设格式 agent:{agentId}:main）
      const sessionKey = `agent:${agentId}:main`;

      await saveCompactionSnapshot(sessionKey, sessionId, agentId, messages);
      migratedCount++;
    }
  } catch {
    // 目录不存在或无权限
  }

  return migratedCount;
}
