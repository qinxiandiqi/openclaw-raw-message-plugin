/**
 * Query logic for raw-message plugin (SQLite-based).
 */

import { queryMessages } from "./db.js";
import type { CapturedMessage, QueryResult } from "./types.js";

export async function queryAgentMessages(
  agentId: string,
  startTime: number,
  endTime: number,
): Promise<QueryResult> {
  const { messages, sessionCount } = queryMessages(agentId, startTime, endTime);

  return {
    messageCount: messages.length,
    sessionCount,
    messages: messages as CapturedMessage[],
  };
}
