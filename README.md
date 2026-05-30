# Agent Source Memory

OpenClaw 插件，实时捕获 agent 对话记录并存入 SQLite，提供按 agent + 时间范围的查询工具。

## 工作原理

### 数据捕获

通过 `api.runtime.events.onSessionTranscriptUpdate` 监听消息写入事件，每条消息写入 `.jsonl` 文件后触发。消息内容经过脱敏处理（与文件内容一致），携带 `messageId`（entryId）用于去重。

### 历史迁移

Gateway 启动时自动扫描所有 session 文件（包括归档文件），批量导入已有记录。重复数据通过 `UNIQUE(agentId, sessionKey, entryId)` 自动跳过。

**扫描的文件类型**：
- `{id}.jsonl` — 活跃 session
- `{id}.jsonl.reset.{ISO}` — Reset 归档
- `{id}.jsonl.deleted.{ISO}` — 维护归档
- `{id}.checkpoint.{cid}.jsonl` — Compaction 快照

## 数据存储

SQLite 数据库位于 `~/.openclaw/agent-source-memory/source-memory.db`。

**Schema**：
```sql
CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agentId TEXT NOT NULL,
  sessionKey TEXT NOT NULL,
  entryId TEXT NOT NULL,       -- randomUUID()，跨路径去重键
  ts INTEGER NOT NULL,         -- Unix 毫秒时间戳
  role TEXT NOT NULL,           -- user / assistant / toolResult
  msg TEXT NOT NULL,            -- JSON 序列化的完整消息
  UNIQUE(agentId, sessionKey, entryId)
);
```

## 工具：query_agent_messages

查询指定 agent 在时间范围内的所有消息。

**参数**：
| 参数 | 类型 | 说明 |
|------|------|------|
| agentId | string | Agent ID（如 `"main"`） |
| startTime | number | 起始时间（Unix 毫秒时间戳） |
| endTime | number | 结束时间（Unix 毫秒时间戳） |

**返回**：
```json
{
  "sessionCount": 3,
  "messageCount": 127,
  "messages": [
    {
      "ts": 1748236800000,
      "role": "user",
      "msg": { "role": "user", "content": "..." }
    }
  ]
}
```

**使用示例**（查询 2026-05-22 全天 CST）：
```
agentId: "main"
startTime: 1779379200000  // 2026-05-22 00:00:00 CST
endTime:   1779465600000  // 2026-05-23 00:00:00 CST
```

## 构建

```bash
pnpm install
pnpm build          # TypeScript 编译
pnpm test           # 运行测试
pnpm plugin:build   # 编译 + 打包插件
```

## 安装

```bash
openclaw plugins install ./path/to/agent-source-memory
```

## 依赖

- `better-sqlite3` — SQLite 存储
- `typebox` — 工具参数 schema
- `openclaw` (peer dependency >= 2026.5.17)
