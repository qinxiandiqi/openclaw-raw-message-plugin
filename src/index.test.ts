import { describe, expect, it } from "vitest";
import { getPluginMetadata } from "openclaw/plugin-sdk/plugin-entry";
import { saveCompactionSnapshot, getSnapshotIndex } from "./snapshot.js";
import { queryAgentMessages } from "./queries.js";

describe("agent-source-memory", () => {
  describe("plugin metadata", () => {
    it("declares query_agent_messages tool", async () => {
      // Import the entry to check metadata
      const { default: entry } = await import("./index.js");
      const metadata = getPluginMetadata(entry);

      expect(metadata).toBeDefined();
      expect(metadata?.tools).toContain("query_agent_messages");
    });
  });

  describe("snapshot", () => {
    it("getSnapshotIndex returns empty array for non-existent agent", async () => {
      const index = await getSnapshotIndex("non-existent-agent-xyz");
      expect(index).toEqual([]);
    });
  });

  describe("queries", () => {
    it("queryAgentMessages returns empty result for non-existent agent", async () => {
      const result = await queryAgentMessages(
        "non-existent-agent-xyz",
        Date.now() - 86400000, // 1 day ago
        Date.now()
      );

      expect(result.snapshotCount).toBe(0);
      expect(result.messageCount).toBe(0);
      expect(result.messages).toEqual([]);
    });
  });
});
