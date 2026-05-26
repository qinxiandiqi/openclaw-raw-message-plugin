/**
 * Agent Source Memory Plugin
 *
 * OpenClaw plugin that preserves session messages before compaction
 * and provides tools to query agent messages within a time range.
 */

import { Type } from "typebox";
import { definePluginEntry, type OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { toolPluginMetadataSymbol } from "openclaw/plugin-sdk/tool-plugin";
import { jsonResult } from "openclaw/plugin-sdk/agent-runtime";
import { queryAgentMessages } from "./queries.js";
import { saveCompactionSnapshot } from "./snapshot.js";
import { migrateExistingSessions } from "./migrate.js";
import type { SessionMessage } from "./types.js";

// 创建工具定义
const queryAgentMessagesTool = {
  label: "Query Agent Messages",
  name: "query_agent_messages",
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
  execute: async (_toolCallId: string, params: unknown) => {
    const { agentId, startTime, endTime } = params as {
      agentId: string;
      startTime: number;
      endTime: number;
    };
    const result = await queryAgentMessages(agentId, startTime, endTime);
    return jsonResult({
      snapshotCount: result.snapshotCount,
      messageCount: result.messageCount,
      messages: result.messages,
    });
  },
};

// 构建 metadata（供验证器使用）
const metadata = {
  id: "agent-source-memory",
  name: "Agent Source Memory",
  description: "Preserve and query agent session messages before compaction",
  activation: { onStartup: true },
  configSchema: { type: "object", properties: {}, additionalProperties: false },
  tools: [
    {
      name: queryAgentMessagesTool.name,
      label: queryAgentMessagesTool.label,
      description: queryAgentMessagesTool.description,
      parameters: queryAgentMessagesTool.parameters as unknown,
    },
  ],
};

// 定义 entry
const entry = definePluginEntry({
  id: "agent-source-memory",
  name: "Agent Source Memory",
  description: "Preserve and query agent session messages before compaction",
  register(api: OpenClawPluginApi) {
    // 网关启动时执行增量迁移（收录所有 agent 的已存在 session 文件）
    api.on("gateway_start", async () => {
      try {
        const count = await migrateExistingSessions();
        if (count > 0) {
          console.log(`[agent-source-memory] Migrated ${count} existing session files`);
        }
      } catch (err) {
        console.error("[agent-source-memory] Migration failed:", err);
      }
    });

    // 注册工具
    api.registerTool({
      name: queryAgentMessagesTool.name,
      label: queryAgentMessagesTool.label,
      description: queryAgentMessagesTool.description,
      parameters: queryAgentMessagesTool.parameters,
      execute: queryAgentMessagesTool.execute,
    });

    // 注册 before_compaction hook
    api.on("before_compaction", async (event, _ctx) => {
      const sessionKey = (event as { sessionKey?: string }).sessionKey;
      const sessionId = (event as { sessionId?: string }).sessionId;
      const messages = (event as { messages?: SessionMessage[] }).messages;
      if (!sessionKey || !sessionId || !messages?.length) return;
      await saveCompactionSnapshot(sessionKey, sessionId, messages);
    });
  },
});

// 手动添加 toolPluginMetadataSymbol（让 validate 通过）
Object.defineProperty(entry, toolPluginMetadataSymbol, {
  value: metadata,
  enumerable: false,
});

export default entry;