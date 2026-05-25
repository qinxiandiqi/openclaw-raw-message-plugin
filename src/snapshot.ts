/**
 * Compaction snapshot saving for agent-source-memory
 *
 * Saves complete session messages before compaction to preserve original data.
 * Snapshots are organized by agentId for efficient querying.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { parseAgentSessionKey } from "openclaw";
import { app } from "openclaw";
import type { SnapshotMeta, SessionMessage } from "./types.js";

const PLUGIN_DATA_DIR = "agent-source-memory";
const SNAPSHOTS_DIR = "snapshots";

/**
 * Get the snapshots directory path for a specific agent
 */
function getSnapshotDir(agentId: string): string {
  return path.join(app.dataDir, PLUGIN_DATA_DIR, SNAPSHOTS_DIR, agentId);
}

/**
 * Get the index file path for a specific agent
 */
function getIndexPath(agentId: string): string {
  return path.join(getSnapshotDir(agentId), "index.json");
}

/**
 * Extract timestamps from messages
 */
function extractTimeRange(messages: SessionMessage[]): { startTime: number; endTime: number } {
  const timestamps = messages
    .map((m) => m.timestamp)
    .filter((t): t is number => typeof t === "number");

  if (timestamps.length === 0) {
    const now = Date.now();
    return { startTime: now, endTime: now };
  }

  return {
    startTime: Math.min(...timestamps),
    endTime: Math.max(...timestamps),
  };
}

/**
 * Update the snapshot index for an agent
 */
async function updateSnapshotIndex(agentId: string, meta: SnapshotMeta): Promise<void> {
  const indexPath = getIndexPath(agentId);

  let index: SnapshotMeta[] = [];
  try {
    const content = await fs.readFile(indexPath, "utf-8");
    index = JSON.parse(content);
  } catch {
    // File doesn't exist yet, start with empty array
  }

  index.push(meta);
  await fs.writeFile(indexPath, JSON.stringify(index, null, 2), "utf-8");
}

/**
 * Save complete session messages to a snapshot before compaction.
 *
 * @param sessionKey - The session key (e.g., "agent:main:main")
 * @param sessionId - The session ID
 * @param messages - Array of session messages to preserve
 * @returns The path to the created snapshot file
 */
export async function saveCompactionSnapshot(
  sessionKey: string,
  sessionId: string,
  messages: SessionMessage[]
): Promise<string> {
  // Parse agentId from sessionKey
  const parsed = parseAgentSessionKey(sessionKey);
  const agentId = parsed?.agentId ?? "unknown";

  // Ensure directory exists
  const snapshotDir = getSnapshotDir(agentId);
  await fs.mkdir(snapshotDir, { recursive: true });

  // Extract time range from messages
  const { startTime, endTime } = extractTimeRange(messages);

  // Generate snapshot filename: {sessionId}.{timestamp}.jsonl
  const filename = `${sessionId}.${Date.now()}.jsonl`;
  const filepath = path.join(snapshotDir, filename);

  // Write messages as JSONL
  const lines = messages.map((m) => JSON.stringify(m));
  await fs.writeFile(filepath, lines.join("\n"), "utf-8");

  // Update index
  const meta: SnapshotMeta = {
    sessionKey,
    sessionId,
    filepath,
    startTime,
    endTime,
    createdAt: Date.now(),
  };
  await updateSnapshotIndex(agentId, meta);

  return filepath;
}

/**
 * Get all snapshot metadata for an agent
 */
export async function getSnapshotIndex(agentId: string): Promise<SnapshotMeta[]> {
  const indexPath = getIndexPath(agentId);

  try {
    const content = await fs.readFile(indexPath, "utf-8");
    return JSON.parse(content);
  } catch {
    return [];
  }
}

/**
 * Delete old snapshots older than the specified maxAge
 */
export async function cleanupOldSnapshots(agentId: string, maxAgeMs: number): Promise<number> {
  const index = await getSnapshotIndex(agentId);
  const cutoff = Date.now() - maxAgeMs;
  let deletedCount = 0;

  const remaining: SnapshotMeta[] = [];

  for (const meta of index) {
    if (meta.createdAt < cutoff) {
      // Delete the snapshot file
      try {
        await fs.unlink(meta.filepath);
        deletedCount++;
      } catch {
        // File might already be deleted
      }
    } else {
      remaining.push(meta);
    }
  }

  // Update index with remaining snapshots
  const indexPath = getIndexPath(agentId);
  if (remaining.length > 0) {
    await fs.writeFile(indexPath, JSON.stringify(remaining, null, 2), "utf-8");
  } else {
    try {
      await fs.unlink(indexPath);
    } catch {
      // Index file might not exist
    }
  }

  return deletedCount;
}
