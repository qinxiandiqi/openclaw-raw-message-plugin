# Openclaw Raw Message Plugin

OpenClaw 插件，实时捕获 agent 对话记录并存入 SQLite，提供按 agent + 时间范围的查询工具。

## 安装

### 方式一：npx 一键安装（推荐）

`openclaw plugins install` 内部使用 `--ignore-scripts`，会导致 `better-sqlite3` 的原生模块无法编译。npx 安装方式绕过此限制：

```bash
npx openclaw-raw-message-plugin install
```

安装脚本会自动：
- 在 `~/.openclaw/extensions/raw-message/` 下安装插件
- 检测 openclaw gateway 使用的 Node.js 版本，用对应版本编译 `better-sqlite3` 原生模块
- 更新 `openclaw.json` 配置
- 重启 gateway 并进行健康检查

指定版本安装：

```bash
npx openclaw-raw-message-plugin install --version 0.4.0
```

### 方式二：openclaw plugins install

> ⚠️ 此方式可能导致 `better-sqlite3` 原生模块缺失，插件无法正常工作。

```bash
openclaw plugins install openclaw-raw-message-plugin
```

### 方式三：本地安装

```bash
openclaw plugins install ./path/to/openclaw-raw-message-plugin
```

## 卸载

```bash
# 卸载插件，同时删除数据库
npx openclaw-raw-message-plugin uninstall

# 卸载插件，保留数据库
npx openclaw-raw-message-plugin uninstall --keep-data
```

## 工作原理

### 数据捕获

通过 `api.runtime.events.onSessionTranscriptUpdate` 监听消息写入事件，每条消息写入 `.jsonl` 文件后触发。消息以原始 JSON 格式完整存储，携带 `messageId`（entryId）用于去重。

### 历史迁移

Gateway 启动时自动扫描所有 session 文件（包括归档文件），批量导入已有记录。重复数据通过 `UNIQUE(agentId, entryId)` 自动跳过。

**扫描的文件类型**：
- `{id}.jsonl` — 活跃 session
- `{id}.jsonl.reset.{ISO}` — Reset 归档
- `{id}.jsonl.deleted.{ISO}` — 维护归档
- `{id}.checkpoint.{cid}.jsonl` — Compaction 快照

## 数据存储

SQLite 数据库位于 `~/.openclaw/raw-message/source-memory.db`。

**从旧版迁移**：若 `~/.openclaw/agent-source-memory/` 存在而新目录不存在，启动时会自动重命名。

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
  UNIQUE(agentId, entryId)
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

## 开发

```bash
pnpm install
pnpm build          # TypeScript 编译
pnpm test           # 运行测试
pnpm plugin:build   # 编译 + 打包插件
```

## 依赖

- `better-sqlite3` — SQLite 存储
- `typebox` — 工具参数 schema
- `openclaw` (peer dependency >= 2026.5.17)

## 许可证

[MIT](LICENSE)
