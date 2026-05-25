/**
 * Agent Source Memory Plugin
 *
 * OpenClaw plugin that preserves session messages before compaction
 * and provides tools to query agent messages within a time range.
 */

import { Type } from "typebox";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { queryAgentMessages } from "./queries.js";
import { saveCompactionSnapshot } from "./snapshot.js";
import type { SessionMessage } from "./types.js";

export default definePluginEntry({
  id: "agent-source-memory",
  name: "Agent Source Memory",
  description: "Preserve and query agent session messages before compaction",

  register(api) {
    // Register the query_agent_messages tool
    api.registerTool({
      name: "query_agent_messages",
      label: "Query Agent Messages",
      description:
        "Query all messages for an agent within a time range. " +
        "Returns messages from both snapshots (compacted sessions) and real-time transcripts.",
      parameters: Type.Object({
        agentId: Type.String({
          description: "Agent ID (e.g. 'main', 'my-agent')",
        }),
        startTime: Type.Number({
          description: "Start time (Unix timestamp in milliseconds)",
        }),
        endTime: Type.Number({
          description: "End time (Unix timestamp in milliseconds)",
        }),
      }),

      async execute({ agentId, startTime, endTime }, _config, _ctx) {
        const result = await queryAgentMessages(agentId, startTime, endTime);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  snapshotCount: result.snapshotCount,
                  messageCount: result.messageCount,
                  messages: result.messages,
                },
                null,
                2
              ),
            },
          ],
        };
      },
    });

    // Register the before_compaction hook to save snapshots
    api.registerHook("before_compaction", async (event, ctx) => {
      if (!ctx.sessionKey || !ctx.sessionId) {
        return;
      }

      const messages = event.messages as SessionMessage[] | undefined;
      if (!messages || messages.length === 0) {
        return;
      }

      await saveCompactionSnapshot(ctx.sessionKey, ctx.sessionId, messages);
    });
  },
});
