# Agent Source Memory

OpenClaw plugin that preserves session messages before compaction and provides tools to query agent messages within a time range.

## Features

- **Snapshot Preservation**: Saves complete session messages to JSONL snapshots before compaction
- **Time-Range Query**: Query all messages for an agent within a specified time range
- **Organized by Agent**: Snapshots are organized by agentId for efficient querying

## Data Storage

Snapshots are stored in:
```
~/.openclaw/agent-source-memory/snapshots/{agentId}/
├── index.json           # Snapshot metadata index
└── {sessionId}.{timestamp}.jsonl  # Individual snapshot files
```

## Tools

### query_agent_messages

Query all messages for an agent within a time range.

**Parameters**:
- `agentId` (string): Agent ID (e.g., 'main', 'my-agent')
- `startTime` (number): Start time (Unix timestamp in milliseconds)
- `endTime` (number): End time (Unix timestamp in milliseconds)

**Returns**:
```json
{
  "snapshotCount": 2,
  "messageCount": 42,
  "messages": [
    {
      "id": "msg_xxx",
      "parentId": null,
      "role": "user",
      "content": "Hello",
      "timestamp": 1748010000000
    }
  ]
}
```

## Hooks

- `before_compaction`: Automatically saves session messages to snapshots before compaction occurs

## Build

```bash
npm install
npm run plugin:build
npm run plugin:validate
npm test
```

## Development

```bash
# Install locally for testing
openclaw plugins install ./path/to/agent-source-memory

# Or link for development
openclaw plugins install --link ./path/to/agent-source-memory
```
