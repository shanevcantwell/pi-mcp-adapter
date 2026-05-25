import { describe, expect, it } from "vitest";
import type { McpConfig } from "../types.ts";

describe("ServerEntry.hiddenTools field exists (compile-time check)", () => {
  it("should accept hiddenTools array in server definition", () => {
    const config: McpConfig = {
      mcpServers: {
        test: {
          command: "node",
          args: ["-e", "1"],
          directTools: ["tool_a"],
          hiddenTools: ["dangerous_tool"], // This should compile
        },
      },
    };
    expect(config.mcpServers.test).toBeDefined();
  });
});
