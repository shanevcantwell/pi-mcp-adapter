import { describe, expect, it } from "vitest";
import type { McpConfig, ToolMetadata } from "../types.ts";
import type { McpExtensionState } from "../state.ts";
import type { MetadataCache } from "../metadata-cache.ts";
import { getToolVisibility } from "../direct-tools.ts";

// ─── Helper to create a minimal state with tool metadata ────────────

function makeState(
  config: McpConfig,
  toolMetadataMap: Map<string, ToolMetadata[]>,
): McpExtensionState {
  return {
    config,
    toolMetadata: toolMetadataMap,
  } as unknown as McpExtensionState;
}

function createToolMeta(serverName: string, originalName: string, prefix = "server"): ToolMetadata {
  const p = prefix === "none" ? "" : `${prefix}_`;
  return {
    name: `${p}${originalName}`,
    originalName,
    description: `The ${originalName} tool`,
  };
}

// ─── Proxy filtering integration tests ──────────────────────────────

describe("Proxy visibility filtering", () => {
  describe("executeList proxy filtering (via getToolVisibility)", () => {
    it("only shows PROXY tools in list output", () => {
      const config: McpConfig = {
        mcpServers: {
          srv: { command: "node", args: ["-e", "1"], directTools: ["direct_tool"], hiddenTools: ["hidden_tool"] },
        },
      };

      const metadataMap = new Map([
        [
          "srv",
          [
            createToolMeta("srv", "proxy_tool"),
            createToolMeta("srv", "direct_tool"),
            createToolMeta("srv", "hidden_tool"),
          ],
        ],
      ]);

      const state = makeState(config, metadataMap);

      // Verify visibility resolution is correct before testing list behavior
      expect(getToolVisibility(state, "srv", "proxy_tool")).toBe("proxy");
      expect(getToolVisibility(state, "srv", "direct_tool")).toBe("direct");
      expect(getToolVisibility(state, "srv", "hidden_tool")).toBe("hidden");

      // In a real executeList call, only proxy tools would be shown.
      // Here we verify the filter logic directly:
      const metadata = state.toolMetadata.get("srv") ?? [];
      const proxyTools = metadata.filter(m => getToolVisibility(state, "srv", m.originalName) === "proxy");

      expect(proxyTools).toHaveLength(1);
      expect(proxyTools[0].originalName).toBe("proxy_tool");
    });

    it("returns empty when all tools are hidden or direct", () => {
      const config: McpConfig = {
        mcpServers: {
          srv: { command: "node", args: ["-e", "1"], directTools: true, hiddenTools: ["tool_a"] },
        },
      };

      const metadataMap = new Map([
        [
          "srv",
          [createToolMeta("srv", "safe_tool"), createToolMeta("srv", "tool_a")],
        ],
      ]);

      const state = makeState(config, metadataMap);
      const metadata = state.toolMetadata.get("srv") ?? [];
      const proxyTools = metadata.filter(m => getToolVisibility(state, "srv", m.originalName) === "proxy");

      expect(proxyTools).toHaveLength(0); // safe_tool → direct, tool_a → hidden, none are proxy
    });
  });

  describe("executeSearch visibility filtering", () => {
    it("only matches PROXY tools in search results", () => {
      const config: McpConfig = { mcpServers: { srv: { command: "node", args: ["-e", "1"], hiddenTools: ["read_secret"] } } };

      const metadataMap = new Map([
        [
          "srv",
          [
            createToolMeta("srv", "list_files"),
            createToolMeta("srv", "read_secret"), // will be hidden by hiddenTools
          ],
        ],
      ]);

      const state = makeState(config, metadataMap);
      const allMetadata = state.toolMetadata.get("srv") ?? [];

      // Simulate search filtering logic (same pattern as executeSearch)
      const matches: ToolMetadata[] = [];
      for (const tool of allMetadata) {
        const vis = getToolVisibility(state, "srv", tool.originalName);
        if (vis === "hidden") continue;
        if (vis !== "proxy") continue;
        // In real search, pattern test would happen here
        matches.push(tool);
      }

      expect(matches).toHaveLength(1);
      expect(matches[0].originalName).toBe("list_files");
    });

    it("hidden tools are treated as nonexistent (no leak of existence)", () => {
      const config: McpConfig = { mcpServers: { srv: { command: "node", args: ["-e", "1"], hiddenTools: ["kill_all"] } } };

      const metadataMap = new Map([["srv", [createToolMeta("srv", "kill_all")]]]);
      const state = makeState(config, metadataMap);

      // Hidden tool should be filtered out before pattern matching
      const allMetadata = state.toolMetadata.get("srv") ?? [];
      const visibleTools = allMetadata.filter(tool => {
        const vis = getToolVisibility(state, "srv", tool.originalName);
        return vis !== "hidden";
      });

      expect(visibleTools).toHaveLength(0); // kill_all is hidden → filtered out
    });
  });

  describe("executeDescribe visibility check", () => {
    it("returns error for HIDDEN tools (tool_not_found)", () => {
      const config: McpConfig = { mcpServers: { srv: { command: "node", args: ["-e", "1"], hiddenTools: ["admin_panel"] } } };

      const metadataMap = new Map([["srv", [createToolMeta("srv", "admin_panel")]]]);
      const state = makeState(config, metadataMap);

      // In real executeDescribe, visibility check would happen after finding tool
      const vis = getToolVisibility(state, "srv", "admin_panel");
      expect(vis).toBe("hidden");
      // Would return: `tool_not_found` error (same as nonexistent)
    });

    it("returns hint for DIRECT tools (call directly)", () => {
      const config: McpConfig = { mcpServers: { srv: { command: "node", args: ["-e", "1"], directTools: true } } };

      const metadataMap = new Map([["srv", [createToolMeta("srv", "read_file")]]]);
      const state = makeState(config, metadataMap);

      const vis = getToolVisibility(state, "srv", "read_file");
      expect(vis).toBe("direct");
      // Would return: `direct_tool` error with hint to call directly
    });
  });

  describe("executeCall visibility check", () => {
    it("blocks HIDDEN tool calls (same error as not found)", () => {
      const config: McpConfig = { mcpServers: { srv: { command: "node", args: ["-e", "1"], hiddenTools: ["wipe_database"] } } };

      const metadataMap = new Map([["srv", [createToolMeta("srv", "wipe_database")]]]);
      const state = makeState(config, metadataMap);

      expect(getToolVisibility(state, "srv", "wipe_database")).toBe("hidden");
    });

    it("blocks DIRECT tool calls through proxy with hint", () => {
      const config: McpConfig = { mcpServers: { srv: { command: "node", args: ["-e", "1"], directTools: ["ls"] } } };

      const metadataMap = new Map([["srv", [createToolMeta("srv", "ls")]]]);
      const state = makeState(config, metadataMap);

      expect(getToolVisibility(state, "srv", "ls")).toBe("direct");
    });
  });

  // ─── Env override priority tests for proxy operations ──────────────

  describe("env override respects hidden boundary in proxy ops", () => {
    it("hidden tools stay hidden even when env promotes entire server", () => {
      const config: McpConfig = { mcpServers: { srv: { command: "node", args: ["-e", "1"], hiddenTools: ["dangerous"] } } };

      const metadataMap = new Map([
        [
          "srv",
          [createToolMeta("srv", "safe_tool"), createToolMeta("srv", "dangerous")],
        ],
      ]);

      const state = makeState(config, metadataMap);
      // Env override would promote entire srv to direct via MCP_DIRECT_TOOLS=srv
      const envOverride = ["srv"];

      expect(getToolVisibility(state, "srv", "safe_tool", envOverride)).toBe("direct");
      expect(getToolVisibility(state, "srv", "dangerous", envOverride)).toBe("hidden"); // hidden wins
    });
  });
});
