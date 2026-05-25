/**
 * Type definitions for agent-source-memory plugin
 */

export interface SnapshotMeta {
  sessionKey: string;
  sessionId: string;
  filepath: string;
  startTime: number;
  endTime: number;
  createdAt: number;
}

export interface QueryResult {
  snapshots: SnapshotMeta[];
  messages: unknown[];
  messageCount: number;
  snapshotCount: number;
}

export interface QueryParams {
  agentId: string;
  startTime: number;
  endTime: number;
}

export interface SessionMessage {
  id?: string;
  parentId?: string | null;
  role?: string;
  content?: string | null;
  timestamp?: number;
}
