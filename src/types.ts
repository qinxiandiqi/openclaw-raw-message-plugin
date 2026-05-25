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

/**
 * Gateway session info from sessions.list RPC
 */
export interface GatewaySession {
  key: string;
  sessionId: string;
  updatedAt?: number;
}

/**
 * Gateway sessions.list response
 */
export interface GatewaySessionsListResult {
  sessions: GatewaySession[];
}

/**
 * Query options for controlling behavior
 */
export interface QueryOptions {
  /** Maximum number of sessions to query (default: 50) */
  maxSessions?: number;
  /** Maximum messages per session (default: 200) */
  maxMessagesPerSession?: number;
  /** Include inactive sessions in results (default: false) */
  includeInactive?: boolean;
}
