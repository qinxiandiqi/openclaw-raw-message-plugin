import { describe, expect, it } from "vitest";
import { saveCompactionSnapshot, getSnapshotIndex } from "./snapshot.js";
import { queryAgentMessages } from "./queries.js";

describe("agent-source-memory", () => {
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
        Date.now() - 86400000,
        Date.now()
      );

      expect(result.snapshotCount).toBe(0);
      expect(result.messageCount).toBe(0);
      expect(result.messages).toEqual([]);
    });
  });
});