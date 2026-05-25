import { describe, expect, it } from "vitest";
import type { McpConfig } from "../types.ts";
import type { McpExtensionState } from "../state.ts";
import { getToolVisibility } from "../direct-tools.ts";

function makeState(config: McpConfig): McpExtensionState {
  return { config } as unknown as McpExtensionState;
}

// ─── Core visibility resolution tests ──────────────────────────────

describe("getToolVisibility", () => {
  it("returns proxy for unconfigured server", () => {
    const state = makeState({ mcpServers: {} });
    expect(getToolVisibility(state, "unknown-server", "some_tool")).toBe("proxy");
  });

  it("returns direct when tool is in directTools array", () => {
    const config: McpConfig = {
      mcpServers: { myserver: { command: "node", args: ["-e", "1"], directTools: ["tool_a"] } },
    };
    expect(getToolVisibility(makeState(config), "myserver", "tool_a")).toBe("direct");
  });

  it("returns proxy when tool is not in directTools array", () => {
    const config: McpConfig = {
      mcpServers: { myserver: { command: "node", args: ["-e", "1"], directTools: ["tool_a"] } },
    };
    expect(getToolVisibility(makeState(config), "myserver", "tool_b")).toBe("proxy");
  });

  it("returns direct when directTools is true (all tools)", () => {
    const config: McpConfig = {
      mcpServers: { myserver: { command: "node", args: ["-e", "1"], directTools: true } },
    };
    expect(getToolVisibility(makeState(config), "myserver", "any_tool")).toBe("direct");
  });

  it("returns proxy when no directTools configured (default)", () => {
    const config: McpConfig = { mcpServers: { myserver: { command: "node", args: ["-e", "1"] } } };
    expect(getToolVisibility(makeState(config), "myserver", "tool_a")).toBe("proxy");
  });

  it("respects global settings.directTools when server has no override", () => {
    const config: McpConfig = {
      mcpServers: { myserver: { command: "node", args: ["-e", "1"] } },
      settings: { directTools: true },
    };
    expect(getToolVisibility(makeState(config), "myserver", "tool_a")).toBe("direct");
  });

  // ─── Hidden priority tests ───────────────────────────────────────

  it("returns hidden when tool is in hiddenTools (overrides direct)", () => {
    const config: McpConfig = {
      mcpServers: { myserver: { command: "node", args: ["-e", "1"], directTools: ["tool_a"], hiddenTools: ["tool_a"] } },
    };
    expect(getToolVisibility(makeState(config), "myserver", "tool_a")).toBe("hidden");
  });

  it("returns hidden when tool is in hiddenTools (overrides directTools: true)", () => {
    const config: McpConfig = {
      mcpServers: { myserver: { command: "node", args: ["-e", "1"], directTools: true, hiddenTools: ["tool_a"] } },
    };
    expect(getToolVisibility(makeState(config), "myserver", "tool_a")).toBe("hidden");
  });

  it("hidden wins over global settings.directTools", () => {
    const config: McpConfig = {
      mcpServers: { myserver: { command: "node", args: ["-e", "1"], hiddenTools: ["tool_a"] } },
      settings: { directTools: true },
    };
    expect(getToolVisibility(makeState(config), "myserver", "tool_a")).toBe("hidden");
  });

  it("non-hidden tools still get direct from global settings", () => {
    const config: McpConfig = {
      mcpServers: { myserver: { command: "node", args: ["-e", "1"], hiddenTools: ["tool_a"] } },
      settings: { directTools: true },
    };
    expect(getToolVisibility(makeState(config), "myserver", "safe_tool")).toBe("direct");
  });

  // ─── Env override tests (MCP_DIRECT_TOOLS simulation) ──────────────

  it("env override promotes entire server to direct", () => {
    const config: McpConfig = { mcpServers: { myserver: { command: "node", args: ["-e", "1"] } } };
    // envOverride: ['myserver'] means promote ALL tools in myserver
    expect(getToolVisibility(makeState(config), "myserver", "any_tool", ["myserver"])).toBe("direct");
  });

  it("env override promotes specific tool only", () => {
    const config: McpConfig = { mcpServers: { myserver: { command: "node", args: ["-e", "1"] } } };
    expect(getToolVisibility(makeState(config), "myserver", "tool_a", ["myserver/tool_a"])).toBe("direct");
    expect(getToolVisibility(makeState(config), "myserver", "tool_b", ["myserver/tool_a"])).toBe("proxy");
  });

  it("env override overrides directTools array but not hiddenTools", () => {
    const config: McpConfig = {
      mcpServers: { myserver: { command: "node", args: ["-e", "1"], directTools: ["tool_a"] } },
    };
    // env promotes entire server → tool_b goes from proxy to direct
    expect(getToolVisibility(makeState(config), "myserver", "tool_b", ["myserver"])).toBe("direct");
  });

  it("hidden wins over env override (security boundary)", () => {
    const config: McpConfig = { mcpServers: { myserver: { command: "node", args: ["-e", "1"], hiddenTools: ["dangerous"] } } };
    // Even though env promotes entire server to direct, dangerous stays hidden
    expect(getToolVisibility(makeState(config), "myserver", "safe_tool", ["myserver"])).toBe("direct");
    expect(getToolVisibility(makeState(config), "myserver", "dangerous", ["myserver"])).toBe("hidden");
  });

  it("hidden wins over env override (specific tool promotion)", () => {
    const config: McpConfig = { mcpServers: { myserver: { command: "node", args: ["-e", "1"], hiddenTools: ["kill_all"] } } };
    // Env promotes kill_all to direct, but hidden still wins
    expect(getToolVisibility(makeState(config), "myserver", "kill_all", ["myserver/kill_all"])).toBe("hidden");
  });
});
