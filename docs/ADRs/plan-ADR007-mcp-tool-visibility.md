# ADR-PI-007: MCP Tool Visibility — Three-State Model (Implementation Plan)

> **For agentic workers:** Use superpowers:subagent-driven-development to implement task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend MCP tool visibility from binary direct/proxy toggle to a three-state model (DIRECT / PROXY / HIDDEN) with proxy filtering, panel UI cycling, and config persistence — all within `pi-mcp-adapter` extension scope, zero Pi core changes.

---

## Status Overview

| Phase | Status | Files Modified | Tests Added |
|---|---|---|---|
| 1: Core resolver + proxy filtering | ✅ COMPLETE | types.ts, direct-tools.ts, proxy-modes.ts, init.ts | visibility.test.ts (15), proxy-filtering.test.ts (9) |
| 2: Direct tool resolution skip | ⏳ PENDING | direct-tools.ts | extend existing |
| 3: Metadata attachment | ⏳ PENDING | tool-metadata.ts, metadata-cache.ts | verify via Phase 5 integration |
| 4: Panel UI + persistence | ⏳ PENDING | mcp-panel.ts, types.ts, config.ts | panel-visibility.test.ts (new) |
| 5: Polish + integrated verification | ⏳ PENDING | proxy-modes.ts | integration.test.ts (extend) |

**Working copy:** `~/github/pi-mcp-adapter` (fork of `nicobailon/pi-mcp-adapter`, branch main, commits `828179f..0d0f843`)
**Full design doc:** `~/AGENTS/ADR/ADR-PI-007_MCP_Tool_Visibility_Three_State_Model.md` (read first)

---

## Recommended Reading Order for Fresh Context

1. **ADR-PI-007** (`~/AGENTS/ADR/ADR-PI-007_MCP_Tool_Visibility_Three_State_Model.md`) — full design doc with handoff notes at bottom
2. `types.ts` (working copy) — current state of all types including Phase 1 additions
3. `direct-tools.ts` — read `getToolVisibility()` resolver, then `resolveDirectTools()` for context on what Phase 2 modifies
4. `proxy-modes.ts` — note how inline visibility filtering was added to each proxy op in Phase 1
5. `__tests__/visibility.test.ts` and `__tests__/proxy-filtering.test.ts` — existing tests before writing new ones

---

## Task Structure for Remaining Phases

### Phase 2: Direct Tool Resolution Skip (~30 lines)

**File:** `direct-tools.ts` (working copy, `~/github/pi-mcp-adapter`)

**What to modify in `resolveDirectTools()` at line ~149:**
After the existing exclusion check (`isToolExcluded(...)`) and before building each spec object:
- Call `getToolVisibility({ config } as McpExtensionState, serverName, tool.name)` 
- If result is `"hidden"`, `continue` (skip registration)
- Apply same pattern for resource tools in the resources loop

**What to modify in `buildProxyDescription()` at line ~279:**
Replace raw count of excluded tools with visibility-aware counting:
- Count only PROXY-state tools when building server summary strings
- Servers with zero proxy-visible tools are already skipped by existing logic (no change needed)

**Tests to add:** Verify that a tool in `hiddenTools` is never registered as direct even when env promotes it.

---

### Phase 3: Metadata Attachment (~50 lines)

**Files:** `tool-metadata.ts`, `metadata-cache.ts`

**In `buildToolMetadata()` at line ~8 of `tool-metadata.ts`:**
- Add optional 6th parameter `config?: McpConfig` to function signature
- After building each ToolMetadata entry, if config provided: call `getToolVisibility({ config } as McpExtensionState, serverName, tool.name)` and attach `.visibility = result`
- Apply same pattern for resource tools

**In `reconstructToolMetadata()` at line ~116 of `metadata-cache.ts`:**
- Add optional 5th parameter `config?: McpConfig` to function signature  
- After building each metadata entry, if config provided: attach `.visibility` computed from config
- Update callers in `init.ts` and commands.ts to pass `state.config` as the new argument

**Tests:** Verify visibility is set correctly on metadata entries after startup — largely covered by integration tests in Phase 5.

---

### Phase 4: Panel UI + Persistence (~120 lines)

**Files:** `mcp-panel.ts`, `types.ts`, `config.ts`

**In `types.ts`:**
- Change `McpPanelResult.changes` type from `Map<string, true | string[] | false>` to `Map<string, { directTools: true | string[] | false; hiddenTools?: string[] }>`

**In `mcp-panel.ts`:**
- `ToolState` interface at line ~84: replace `isDirect: boolean` + `wasDirect: boolean` with `visibility: ToolVisibility` + `wasVisibility: ToolVisibility`
- Constructor at line ~133: compute visibility from config (not env override) for baseline; store `originalDirectTools` per server
- Toggle logic in `handleInput()` and `toggleItem()`: cycle through ["proxy", "direct", "hidden"] on space bar instead of boolean flip
- `buildResult()` at line ~279: rewrite to produce `{ directTools, hiddenTools? }` objects with sentinel preservation for `directTools: true`
- `renderToolRow()` at line ~791: show ● (green) / ○ (dim) / ✕ (red) icons; add ⚡ marker when visibility differs from wasVisibility (env-promoted)

**In `config.ts`:**
- Extend `writeDirectToolsConfig()` at line ~631 to handle the new `{ directTools, hiddenTools? }` shape alongside existing logic

---

### Phase 5: Polish + Integrated Verification (~60 lines)

**File:** `proxy-modes.ts`

**In `executeStatus()` at line ~159:**
- Replace single `toolCount` with per-state counts (direct/proxy/hidden) using inline `getToolVisibility()` calls on each metadata entry
- Update output format to show breakdown: `"server_name (3 direct, 5 proxy, 2 hidden)"`

**Verification of resource tools (`get_*` pseudo-tools):**
- Ensure visibility filtering applies equally to resource-derived tool names (e.g., `get_secret_config`) as it does to regular MCP tools
- This is already handled by the inline resolver since both use `tool.originalName` for lookup

---

## Verification Commands (Copy-Paste Ready)

```bash
cd ~/github/pi-mcp-adapter

# Phase 1 tests (fast, should all pass)
npx vitest run __tests__/visibility.test.ts __tests__/proxy-filtering.test.ts --reporter=verbose

# Full suite (ignore the 2 interactive-visualizer failures — pre-existing)
npx vitest run --reporter=verbose

# Type check after any change
npx tsc --noEmit

# Phase 1 git status
git diff --stat HEAD~4
git log --oneline -5
```

---

## Key Invariants (Must Not Change)

1. **Visibility is computed, not cached** — `.visibility` on ToolMetadata is optional convenience only
2. **Original names for resolution** — never use prefixed display name in visibility lookup  
3. **Hidden wins over everything** — including `MCP_DIRECT_TOOLS` env override (security boundary)
4. **Same error path for hidden tools through proxy** — returns `tool_not_found` (no existence leak)
5. **Phase 1 proxy filtering works without Phase 3 metadata attachment** — inline resolver calls handle it
