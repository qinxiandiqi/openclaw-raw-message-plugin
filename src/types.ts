/**
 * Type definitions for agent-source-memory plugin (SQLite-based)
 */

export interface CapturedMessage {
  ts: number;
  role: string;
  msg: unknown;
  entryId: string;
}

export interface SessionIndexEntry {
  agentId: string;
  sessionId: string;
  sessionKey: string | null;
  startTime: number | null;
  endTime: number | null;
  messageCount: number;
  finalized: boolean;
  endReason: string | null;
}

export interface QueryResult {
  messageCount: number;
  sessionCount: number;
  messages: CapturedMessage[];
}
