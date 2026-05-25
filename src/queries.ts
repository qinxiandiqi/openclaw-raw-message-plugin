/**
 * Query logic for agent-source-memory
 *
 * Queries session messages from snapshots and transcript files
 * within a specified time range for a given agent.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { app } from "openclaw";
import { getSnapshotIndex } from "./snapshot.js";
import type { SnapshotMeta, QueryResult, SessionMessage } from "./types.js";

const PLUGIN_DATA_DIR = "agent-source-memory";
const SNAPSHOTS_DIR = "snapshots";

/**
 * Get the snapshots directory for an agent
 */
function getSnapshotDir(agentId: string): string {
  return path.join(app.dataDir, PLUGIN_DATA_DIR, SNAPSHOTS_DIR, agentId);
}

/**
 * Check if a message falls within the time range
 */
function isInTimeRange(message: SessionMessage, startTime: number, endTime: number): boolean {
  const ts = message.timestamp ?? 0;
  return ts >= startTime && ts <= endTime;
}

/**
 * Read messages from a snapshot file
 */
async function readSnapshotMessages(filepath: string): Promise<SessionMessage[]> {
  try {
    const content = await fs.readFile(filepath, "utf-8");
    return content
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as SessionMessage);
  } catch {
    return [];
  }
}

/**
 * Filter messages by time range
 */
function filterMessagesByTimeRange(
  messages: SessionMessage[],
  startTime: number,
  endTime: number
): SessionMessage[] {
  return messages.filter((m) => isInTimeRange(m, startTime, endTime));
}

/**
 * Deduplicate and sort messages by timestamp
 */
function dedupeAndSort(messages: SessionMessage[]): SessionMessage[] {
  // Deduplicate by message id
  const seen = new Map<string, SessionMessage>();
  for (const msg of messages) {
    const id = msg.id ?? `${msg.parentId}-${msg.role}-${msg.timestamp}`;
    if (!seen.has(id)) {
      seen.set(id, msg);
    }
  }

  // Sort by timestamp
  const uniqueMessages = Array.from(seen.values());
  uniqueMessages.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));

  return uniqueMessages;
}

/**
 * Query all messages for an agent within a time range.
 *
 * Combines data from:
 * 1. Snapshots - compacted historical sessions
 * 2. Real-time transcripts - current uncompacted sessions
 *
 * @param agentId - The agent ID to query
 * @param startTime - Start of time range (Unix timestamp in ms)
 * @param endTime - End of time range (Unix timestamp in ms)
 * @returns Query result with messages and snapshot metadata
 */
export async function queryAgentMessages(
  agentId: string,
  startTime: number,
  endTime: number
): Promise<QueryResult> {
  const messages: SessionMessage[] = [];
  const matchedSnapshots: SnapshotMeta[] = [];

  // 1. Query from snapshots (compacted historical sessions)
  const snapshotDir = getSnapshotDir(agentId);

  try {
    const index = await getSnapshotIndex(agentId);

    // Filter snapshots that overlap with the time range
    const relevantSnapshots = index.filter(
      (s) => s.startTime <= endTime && s.endTime >= startTime
    );
    matchedSnapshots.push(...relevantSnapshots);

    // Read messages from each relevant snapshot
    for (const snapshot of relevantSnapshots) {
      const snapshotMessages = await readSnapshotMessages(snapshot.filepath);
      const filtered = filterMessagesByTimeRange(snapshotMessages, startTime, endTime);
      messages.push(...filtered);
    }
  } catch {
    // Snapshot directory doesn't exist yet
  }

  // 2. Query from real-time transcripts (current uncompacted sessions)
  // TODO: Implement real-time transcript reading via gatewayRpc
  // This requires:
  // 1. Get current session list via gatewayRpc("sessions.list", { agentId })
  // 2. Read each session's transcript file
  // 3. Filter by time range and add to messages

  // 3. Deduplicate and sort
  const uniqueMessages = dedupeAndSort(messages);

  return {
    snapshots: matchedSnapshots,
    messages: uniqueMessages,
    messageCount: uniqueMessages.length,
    snapshotCount: matchedSnapshots.length,
  };
}

/**
 * List all agents that have snapshots
 */
export async function listAgentsWithSnapshots(): Promise<string[]> {
  const snapshotsRoot = path.join(app.dataDir, PLUGIN_DATA_DIR, SNAPSHOTS_DIR);

  try {
    const entries = await fs.readdir(snapshotsRoot, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

/**
 * Get snapshot statistics for an agent
 */
export async function getSnapshotStats(agentId: string): Promise<{
  snapshotCount: number;
  totalMessages: number;
  oldestSnapshot: number | null;
  newestSnapshot: number | null;
}> {
  const index = await getSnapshotIndex(agentId);

  if (index.length === 0) {
    return {
      snapshotCount: 0,
      totalMessages: 0,
      oldestSnapshot: null,
      newestSnapshot: null,
    };
  }

  let totalMessages = 0;
  let oldestSnapshot: number | null = null;
  let newestSnapshot: number | null = null;

  for (const meta of index) {
    totalMessages++;

    if (oldestSnapshot === null || meta.createdAt < oldestSnapshot) {
      oldestSnapshot = meta.createdAt;
    }
    if (newestSnapshot === null || meta.createdAt > newestSnapshot) {
      newestSnapshot = meta.createdAt;
    }
  }

  return {
    snapshotCount: index.length,
    totalMessages,
    oldestSnapshot,
    newestSnapshot,
  };
}
