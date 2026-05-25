# ADR-PI-007: MCP Tool Visibility — Three-State Model

**Status:** Phase 1 complete — proxy filtering and resolver live; Phases 2–5 pending
**Date:** 2026-05-24
**Implementation repo:** `~/github/pi-mcp-adapter`
**Handoff doc:** `~/AGENTS/ADR/ADR-PI-007_MCP_Tool_Visibility_Three_State_Model.md` (this file) + handoff notes below  
**Scope:** `pi-mcp-adapter` extension only (zero Pi core changes)  
**Supersedes:** N/A  

---

## Problem Statement

The MCP TUI panel (`/mcp`) lets users toggle individual tools between "direct" and "proxy". The stock behavior of toggling a tool off was intended to completely hide it from the model — removing it from both direct registration *and* proxy discoverability. However, only the first half works: toggled-off tools are removed from `pi.registerTool()` but remain fully visible through `mcp({search})`, `mcp({list})`, `mcp({describe})`, and `mcp({tool})`.

The root cause is architectural: there's a registration axis (direct vs. proxy) but no visibility axis. The proxy layer in `proxy-modes.ts` operates on raw `state.toolMetadata` with no awareness of per-tool toggle intent.

Additionally, the 2-state model doesn't express an important user need: **tools that should exist but not be discovered autonomously** — destructive operations, internal debugging tools, credential-bearing calls that the model shouldn't find through search.

## Decision

Extend from a binary direct/proxy toggle to a **three-state visibility model**:

| State | Registration | Proxy discoverable | Token cost | Use case |
|---|---|---|---|---|
| **DIRECT** | First-class Pi tool via `registerTool()` | Hidden (already available directly) | High (~100-500 tokens/tool, always in system prompt) | High-frequency tools the model calls >3x/session |
| **PROXY** | Not registered | Visible through `mcp({search/list/describe/call})` | Low (only when searched, ~20-50 tokens/match) | Occasional-use tools with large schemas |
| **HIDDEN** | Not registered | Filtered out of all proxy operations; returns "not found" | Zero | Dangerous ops, internal tools, anything the model shouldn't discover autonomously |

Each tool occupies exactly one state. This is a single visibility axis — not separate registration + visibility layers.

## Scope Boundary (Extension-Only)

All changes are within `~/.pi/npm/node_modules/pi-mcp-adapter/`. No Pi core modifications. The adapter uses existing SDK APIs without changing their contract:

| API | Usage | Change needed? |
|---|---|---|
| `pi.registerTool()` | Direct tool registration | No — just register fewer tools when visibility is not "direct" |
| `pi.getAllTools()` | Proxy call to detect native Pi tools | No — read-only consumer of existing API |
| Agent system prompt / `_rebuildSystemPrompt` | Tool snippets in context | No — driven by what's registered, which we control |

## Design

### 1. Type and Config Changes (`types.ts`)

```typescript
export type ToolVisibility = "direct" | "proxy" | "hidden";

// Add to ServerEntry (additive, backward-compatible)
export interface ServerEntry {
  // ... existing fields ...
  
  /** 
   * Tools explicitly hidden from both direct registration and proxy discovery.
   * Takes priority over directTools — a tool in both arrays is HIDDEN.
   */
  hiddenTools?: string[];
}

// Runtime extension on ToolMetadata (computed, not persisted to cache)
export interface ToolMetadata {
  // ... existing fields ...
  
  /** Computed at resolution time from config + env overrides. Not cached. */
  visibility?: ToolVisibility;
}
```

### 2. Visibility Resolution (`direct-tools.ts` — new function)

Central resolver, single source of truth:

```typescript
export function getToolVisibility(
  state: McpExtensionState,
  serverName: string,
  originalName: string,
): ToolVisibility {
  const definition = state.config.mcpServers[serverName];
  if (!definition) return "proxy"; // fallback for unconfigured servers
  
  // Layer 1: Hidden takes absolute priority (security boundary)
  if (Array.isArray(definition.hiddenTools) && definition.hiddenTools.includes(originalName)) {
    return "hidden";
  }
  
  // Layer 2: Direct tool filter resolution (existing logic from resolveDirectTools, extracted)
  const envOverride = process.env.MCP_DIRECT_TOOLS;
  let toolFilter: true | string[] | false = false;
  
  if (envOverride && envOverride !== "__none__") {
    // Parse env override — same as existing resolveDirectTools logic
    // Hidden tools still win even with env override (security boundary)
  } else {
    if (definition.directTools !== undefined) {
      toolFilter = definition.directTools;
    } else if (state.config.settings?.directTools) {
      toolFilter = state.config.settings.directTools;
    }
  }
  
  if (toolFilter === true) return "direct";
  if (Array.isArray(toolFilter) && toolFilter.includes(originalName)) return "direct";
  
  // Layer 3: Default
  return "proxy";
}
```

**Priority chain:** `excludeTools` > `hiddenTools` > `envOverride(MCP_DIRECT_TOOLS)` > `directTools` (per-server) > `directTools` (global settings). Hidden always wins over env override.

**No `isToolVisibleInProxy()` helper.** The comparison `visibility === "proxy"` is inlined at call sites. Extracting a one-line equality check adds indirection without clarity.

### 3. Proxy Filtering (`proxy-modes.ts`)

All four proxy operations filter by visibility using **inline** `getToolVisibility()` calls — not the `.visibility` field on metadata. This keeps Phase 1 independent from Phase 2's metadata attachment:

```typescript
// In executeList(), after fetching metadata:
for (const tool of metadata) {
  const vis = getToolVisibility(state, server, tool.originalName);
  if (vis !== "proxy") continue; // skip DIRECT and HIDDEN
  // ... include in output
}
```

| Operation | Current behavior | New behavior |
|---|---|---|
| `executeList(server)` | Lists ALL tools from metadata | Only PROXY-state tools; DIRECT excluded (already direct), HIDDEN filtered out |
| `executeSearch(query)` | Searches ALL tools across servers | Only PROXY-state tools match |
| `executeDescribe(name)` | Describes any found tool | Returns "not found" for HIDDEN; returns "call directly" hint for DIRECT |
| `executeCall(name, args)` | Calls any found tool | Returns "tool not visible (hidden)" for HIDDEN; "call as native Pi tool" for DIRECT |

**Error shaping:** Hidden tools return **the exact same code path and message shape** as truly nonexistent tools — using the existing `tool_not_found` error. The model cannot distinguish a hidden tool from one that doesn't exist through error pattern analysis. Structured `details` field carries `{ error: "tool_not_visible", reason: "hidden" }` for observability without leaking existence to the narrative output.

### 4. Direct Tool Resolution Changes (`direct-tools.ts`)

In `resolveDirectTools()`, skip tools that are resolved as HIDDEN:

```typescript
// After existing exclusion check, before registration:
const visibility = getToolVisibility(state, serverName, tool.name);
if (visibility === "hidden") continue;  // hidden always wins
```

### 5. Metadata Resolution (`init.ts`, `metadata-cache.ts`) — Optional Convenience Field

When building or reconstructing `ToolMetadata` from cache, attach computed visibility as an optional convenience field:

```typescript
// In buildToolMetadata() and reconstructToolMetadata():
const entry = /* ... existing construction ... */;
entry.visibility = getToolVisibility(state, serverName, tool.name);
```

This is additive — proxy filtering works without it (via inline `getToolVisibility()` calls). The field exists for downstream code that wants to read `.visibility` directly.

### 6. Panel UI (`mcp-panel.ts`)

3-way cycling on toggle key (space):

```typescript
interface ToolState {
  name: string;
  description: string;
  visibility: ToolVisibility;      // replaces isDirect boolean
  wasVisibility: ToolVisibility;   // dirty tracking
  estimatedTokens: number;
}

// Toggle order: PROXY → DIRECT → HIDDEN → PROXY ...
function cycleVisibility(tool: ToolState): void {
  const order: ToolVisibility[] = ["proxy", "direct", "hidden"];
  const currentIdx = order.indexOf(tool.visibility);
  tool.visibility = order[(currentIdx + 1) % 3];
}
```

**Visual indicators:** Three distinct icons per tool:
- `●` (green, code 32) = DIRECT  
- `○` (dim/description color) = PROXY  
- `✕` or `◌` (red/amber, code 31/33) = HIDDEN

**Result building for persistence:**

```typescript
interface McpPanelServerChanges {
  directTools: true | string[] | false;
  hiddenTools?: string[];
}
```

#### `directTools: true` Sentinel Preservation

When original config had `directTools: true` (promote ALL tools including future ones), and the user hides one tool, save must NOT silently convert to an explicit array — that would demote new tools arriving after reconnect.

Panel constructor stores the original value per server:
```typescript
interface ServerState {
  // ... existing fields ...
  originalDirectTools: true | string[] | false;
}
```

`buildResult()` preserves the sentinel when all non-hidden tools remain direct:
```typescript
// In buildResult():
const directNames = server.tools.filter(t => t.visibility === "direct").map(t => t.name);
const hiddenNames = server.tools.filter(t => t.visibility === "hidden").map(t => t.name);
const proxyCount = server.tools.filter(t => t.visibility === "proxy").length;

let nextDirect: true | string[] | false;
if (directNames.length === 0) {
  nextDirect = false;
} else if (server.originalDirectTools === true && proxyCount === 0) {
  // All non-hidden tools still DIRECT → preserve sentinel
  nextDirect = true;
} else {
  // Switched to explicit array or all off
  nextDirect = directNames.length > 0 ? directNames : false;
}
```

#### Env-Promoted Tool Dirty Tracking

`wasVisibility` reflects the **config-only baseline** — not effective state including env overrides. This way, any divergence from config is a dirty change requiring write-back:

```typescript
// Panel constructor: compute wasVisibility from config ONLY (ignore MCP_DIRECT_TOOLS env)
const configVis = /* resolve without env override */;
tools.push({
  name: tool.name,
  visibility: effectiveVisibility(configVis, envPromoted), // display state includes env
  wasVisibility: configVis,  // ← config-only baseline for dirty tracking
});
```

If a tool is env-promoted (effective=`direct`, `wasVisibility`=`proxy`), cycling to HIDDEN correctly emits `hiddenTools: [toolX]` — which overrides the env promotion at runtime. Env-promoted tools get a visual marker (`⚡`) in the panel so users understand why a tool shows as DIRECT.

#### Result emission

```typescript
const changes = new Map<string, McpPanelServerChanges>();
for (const server of this.servers) {
  const changed = server.tools.some(t => t.visibility !== t.wasVisibility);
  if (!changed) continue;
  
  // ... compute nextDirect and hiddenNames as above ...
  changes.set(server.name, { directTools: nextDirect, hiddenTools: hiddenNames.length ? hiddenNames : undefined });
}
```

### 7. Config Write-Back (`commands.ts` / `config.ts`)

Extend `writeDirectToolsConfig()` to handle the new `hiddenTools` field alongside existing `directTools`:

```typescript
// On panel save, write back BOTH arrays:
serverDefinition.directTools = /* computed from direct-state tools */;
if (hiddenNames.length > 0) {
  serverDefinition.hiddenTools = hiddenNames;
} else if (serverDefinition.hiddenTools && !serverDefinition.hiddenTools.length) {
  delete serverDefinition.hiddenTools; // clean up empty arrays
}
```

### 8. Proxy Description (`direct-tools.ts` — `buildProxyDescription`)

Exclude HIDDEN tools from proxy tool counts and server summaries:

```typescript
const visibleCount = entry?.tools?.filter(
  t => getToolVisibility(state, serverName, t.name) === "proxy"
).length ?? 0;
// Only include servers with visibleCount > 0 in the summary
```

### 9. Observability

#### Startup-Time Config Validation (`init.ts`)

Scan all server configs at startup before connecting. Surface contradictions upfront:

```typescript
function validateVisibilityConfig(config: McpConfig): void {
  for (const [serverName, definition] of Object.entries(config.mcpServers)) {
    const directSet = new Set<string>();
    
    if (Array.isArray(definition.directTools)) {
      for (const name of definition.directTools) directSet.add(name);
    }
    // Skip static check when directTools === true (don't know tool list yet)
    
    const hiddenSet = new Set(definition.hiddenTools ?? []);
    for (const name of directSet) {
      if (hiddenSet.has(name)) {
        console.warn(`MCP: "${serverName}/${name}" is in both directTools and hiddenTools — will be treated as HIDDEN`);
      }
    }
  }
}
```

Called from `initializeMcp()` after config load, before server connections.

#### Runtime Resolution Logging

- Debug log at resolution time (when `debug: true` on server config):  
  `MCP: visibility for {server}/{tool} = {state}`
- Defensive default: if visibility resolver returns unexpected state, default to "proxy" with `console.warn`

### 10. Status Command Visibility-Awareness (`proxy-modes.ts` — `executeStatus`)

Make the status command reflect visibility-filtered counts:

```typescript
// Instead of raw toolCount = metadata?.length ?? 0:
let proxyCount = 0, directCount = 0, hiddenCount = 0;
for (const tool of metadata) {
  const vis = getToolVisibility(state, name, tool.originalName);
  if (vis === "direct") directCount++;
  else if (vis === "hidden") hiddenCount++;
  else proxyCount++;
}

// Output: server_name (3 direct, 5 proxy, 2 hidden)
```

This gives users visibility into how many tools the model can actually access in each mode.

## Backward Compatibility

| Concern | Strategy |
|---|---|
| Existing configs with `directTools: true/false/string[]` | No change — these continue to work. Tools not mentioned in config default to PROXY visibility. |
| `MCP_DIRECT_TOOLS` env var (subagents) | Unchanged behavior for promoting tools to direct. Hidden tools still respect `hiddenTools` even with env override (security boundary). |
| Metadata cache format (`mcp-cache.json`) | No change — visibility is computed from config, not stored in cache. Cache continues to store raw MCP server output only. |
| Panel result shape (`McpPanelResult.changes`) | Internal extension-only change: `Map<string, true \| string[] \| false>` extends to carry hidden tool names. No external consumers affected. |

## Implementation Roadmap

Phases are designed to be **independent and shippable in isolation**. Proxy filtering uses inline `getToolVisibility()` calls (not the `.visibility` metadata field), so Phase 1 works without Phase 2.

### Phase 1: Core visibility resolution + proxy filtering (~250 lines) — ✅ COMPLETE

**Files modified:** `types.ts`, `direct-tools.ts`, `proxy-modes.ts`, `init.ts`

Completed:
- [x] Add `ToolVisibility` type and `hiddenTools?: string[]` to `ServerEntry` in `types.ts`
- [x] Implement `getToolVisibility()` resolver function in `direct-tools.ts`
- [x] Update all 4 proxy operations (`executeList`, `executeSearch`, `executeDescribe`, `executeCall`) in `proxy-modes.ts` — inline `getToolVisibility()` calls, same error path as `tool_not_found` for hidden tools
- [x] Startup-time config contradiction validation (`validateVisibilityConfig()` in `init.ts`)

**Tests:** `__tests__/visibility.test.ts` (15 tests), `__tests__/proxy-filtering.test.ts` (9 tests). Full suite: 337/339 pass.

**Git commit range:** `828179f..0d0f843`

### Phase 2: Direct tool resolution skip (~30 lines) — PENDING

**Files:** `direct-tools.ts`

Changes:
5. Update `resolveDirectTools()` to skip hidden tools (`getToolVisibility() === "hidden"` → continue)
6. Update `buildProxyDescription()` to exclude hidden tools from server summary counts
7. Structured error signals for visibility-filtered proxy calls in `details` field

**Verification:** Hidden tools are never registered as direct tools even when env promotes them.

### Phase 3: Metadata attachment — optional convenience (~50 lines) — PENDING

**Files:** `tool-metadata.ts`, `metadata-cache.ts`

Changes:
8. Attach computed `.visibility` to `ToolMetadata` during `buildToolMetadata()` (line ~8 of tool-metadata.ts) and `reconstructToolMetadata()` (line ~116 of metadata-cache.ts). Both functions gain optional `config?` parameter.

**Verification:** Confirm visibility is set correctly on metadata entries after startup and reconnect. Purely additive — no other code depends on this field.

### Phase 4: Panel UI + persistence (~120 lines) — PENDING

**Files:** `mcp-panel.ts`, `types.ts`, `config.ts`, `commands.ts`

Changes:
9. Update `ToolState` from `isDirect: boolean` to `visibility: ToolVisibility`
10. Implement 3-way visibility cycling on space key (PROXY → DIRECT → HIDDEN)
11. Update render indicators (3 distinct icons per state; env-promoted marker `⚡`)
12. `buildResult()` with sentinel preservation for `directTools: true`, config-only `wasVisibility` baseline, hidden tool names emission
13. Config write-back handles both `directTools` and `hiddenTools` fields

**Verification:** Full round-trip: toggle through all 3 states → save → verify config writes correctly (sentinel preserved) → reload session → state restored. Env-promoted tools show marker, hiding them persists correctly.

### Phase 5: Polish (~60 lines) — PENDING

**Files:** `proxy-modes.ts`, `init.ts`

Changes:
14. Visibility-aware status counts in `executeStatus()` (direct/proxy/hidden breakdown)
15. Resource tool visibility verification end-to-end (`get_*` pseudo-tools follow same rules)
16. Edge case: all tools on server hidden → server omitted from proxy description entirely

**Verification:** Status command shows accurate per-state counts. Resource tools can be hidden and remain hidden through reconnect.

## Risks and Mitigations

| Risk | Severity | Mitigation |
|---|---|---|
| Config contradiction: tool in both `directTools` and `hiddenTools` | Medium | Hidden takes priority; startup-time scan surfaces all contradictions upfront, not just at resolution time |
| Removed tools lose HIDDEN state on reconnect | Low | Tools that disappear from a server lose their panel entries including hidden state. If they reappear later, they default to PROXY (safer than leaking). Documented expected behavior. |
| Proxy tool description misleading when all tools hidden | Low | Filter zero-visibility servers from `buildProxyDescription()` summary entirely |
| Visibility resolver returns unexpected state due to config corruption | Low | Defensive default to "proxy" with `console.warn`. Never crash or make tools invisible by accident. |
| Panel result shape change breaks something downstream | None | Internal-only type — no external consumers of `McpPanelResult.changes` value shape beyond the adapter itself. |
| Resource tools bypass visibility check | Medium (security) | Explicit verification in Phase 5 that `get_*` resource pseudo-tools follow same hidden/direct/proxy rules as regular MCP tools.

## Alternatives Considered and Rejected

### Alternative A: Per-tool visibility map replacing `directTools` + `hiddenTools`

A single `{ tools: { "tool_a": "hidden", "tool_b": "direct" } }` config shape. More flexible but doesn't match the panel's natural set-based toggle interaction pattern. The two-array model maps directly to UI operations (toggle into/out of a category). Rejected for complexity vs. gain tradeoff.

### Alternative B: Description-only direct registration ("lightweight direct")

A 4th state where tools appear with description but lazy schema fetch on first call. Requires Pi host changes to tool system (lazy schema resolution). Beyond adapter scope. Can be revisited as a future enhancement if the model needs it. Rejected for now.

### Alternative C: Ephemeral session-level visibility toggles only

Don't persist hidden state — keep it session-local. Rejected because hiding is an intentional user decision ("don't let the model call this") that should survive restarts. The existing pattern already persists direct/ proxy changes; extending to hidden follows the contract.

## Implementation Reference Material

**Working copy:** `~/github/pi-mcp-adapter` (fork of original)
**Read in dependency order below.**

### Core types (read first)

**`types.ts`** — All shared interfaces, enums, and utility functions. Key definitions:
- `ServerEntry` (line 284) — server config shape;
  - Existing: `directTools?: boolean | string[]`, `excludeTools?: string[]`
  - **Phase 1 done:** added `hiddenTools?: string[]` at line ~317
- `McpConfig` (line 340) — root config with `mcpServers`, `imports`, `settings`
- `ToolVisibility` (line 350) — new enum: `"direct" | "proxy" | "hidden"`
- `ToolMetadata` (line 352) — per-tool metadata shape;
  - **Phase 1 done:** added `.visibility?: ToolVisibility` at line ~363
- `DirectToolSpec` (line 364) — resolved direct tool spec passed to `pi.registerTool()`
- `McpPanelResult` (line 394) — panel output shape;
  - **Phase 4:** will change `.changes` value type from `true | string[] | false` to `{ directTools: true | string[] | false; hiddenTools?: string[] }`
- `isToolExcluded()` (line 431) — existing exclusion check against `excludeTools`; returns true for excluded tools
- `formatToolName()`, `getServerPrefix()` — name transformation utilities; visibility resolution uses **original** tool names (not prefixed)

**`state.ts`** — Extension runtime state. Key definition:
- `McpExtensionState` — shared mutable state object passed through all code paths. Contains `.config: McpConfig`, `.toolMetadata: Map<string, ToolMetadata[]>`

**`state.ts`** — Extension runtime state. Key definition:
- `McpExtensionState` (line 26) — shared mutable state object passed through all code paths. Contains `.config: McpConfig`, `.toolMetadata: Map<string, ToolMetadata[]>`

### Visibility resolution and direct tool registration

**`direct-tools.ts`** — Direct tool resolution at extension load time.
- `getToolVisibility()` (line 47) — **Phase 1 done:** full resolver with priority chain: hidden > excludeTools > envOverride > directTools(server) > directTools(global) > proxy(default). Takes `(state, serverName, originalName, envOverride?) → ToolVisibility`.
- `resolveDirectTools()` (line 149) — signature `(config, cache, prefix, envOverride?) → DirectToolSpec[]`. Iterates servers and tools from cache. **Phase 2:** add hidden-tool skip after exclusion check.
- `buildProxyDescription()` (line 279) — builds the `mcp` proxy tool's description string. **Phase 2:** filter hidden tools from server summary counts here.
- `getMissingConfiguredDirectToolServers()` (line 256) — detects servers with direct tools configured but no cache yet. Not affected by visibility.

**How it connects to extension entry point (`index.ts`, line ~50):**
```
resolveDirectTools(earlyConfig, earlyCache, prefix, envOverride)
  → DirectToolSpec[] 
  → pi.registerTool() for each spec (line ~62 of index.ts)
```
This runs **once at extension load time**, before `session_start`. It uses static config + cache — no live state. Hidden-tools filtering must happen here.

### Proxy operations (bug location — where visibility filtering goes)

**`proxy-modes.ts`** — All proxy tool dispatch handlers.
- `executeStatus()` (line 159) — server status summary;
  - **Phase 1 done:** import of `getToolVisibility` added at top of file
  - **Phase 5:** update to show per-state counts (direct/proxy/hidden breakdown)
- `executeDescribe()` (line 215) — describe a single tool;
  - **Phase 1 done:** visibility check after finding tool, returns error for HIDDEN (same as not found), hint for DIRECT
- `executeSearch()` (line 271) — search across all servers;
  - **Phase 1 done:** filters matches by visibility = "proxy", skips hidden/direct before pattern test
- `executeList()` (line 388) — list tools for a server;
  - **Phase 1 done:** filters to only PROXY-state tools; returns message when all filtered out
- `executeCall()` (line 505) — execute a tool through proxy;
  - **Phase 1 done:** visibility check after tool resolution but before connection attempt, returns appropriate errors

All functions receive `(state: McpExtensionState, ...)` as first parameter. Use `getToolVisibility(state, serverName, tool.originalName)` for inline resolution.

**How they connect to extension entry point (`index.ts`, line ~200):**
The `mcp` proxy tool's `.execute()` handler dispatches based on params:
```
params.tool      → executeCall()
params.describe  → executeDescribe()
params.search    → executeSearch()
params.server    → executeList()
none             → executeStatus()
```

### Initialization and metadata lifecycle

**`init.ts`** — Session startup, server connections, metadata building.
- `validateVisibilityConfig()` (line 32) — **Phase 1 done:** scans config for directTools+hiddenTools overlap, warns via console.warn. Called from initializeMcp() after config load.
- `initializeMcp()` (line 50) — main entry point called from `session_start`. Builds state object, connects servers, populates `toolMetadata` map.
- `updateServerMetadata()` (line ~245) — refreshes metadata for a single server on reconnect
- `lazyConnect()` (line ~319) — deferred connection for lazy/lifecycle servers; called from proxy ops and direct tool executors

**`tool-metadata.ts`** — Metadata construction helpers.
- `buildToolMetadata()` (line 8) — builds `ToolMetadata[]` from live connection. **Phase 3:** add optional `config?` parameter, attach `.visibility` to each entry when provided.
- `findToolByName()` (line 74) — lookup by prefixed name with normalization; used by proxy ops
- `formatSchema()` (line 82) — schema formatting for describe/call error output

**`metadata-cache.ts`** — Persistent cache of MCP server metadata. **Not modified in Phase 1.**
- `reconstructToolMetadata()` (line 116) — rebuilds `ToolMetadata[]` from cached entry at startup.
  - Signature: `(serverName, entry, prefix, definition)` → `ToolMetadata[]`
  - **Phase 3:** add optional `config?` parameter, attach `.visibility` to each rebuilt entry when provided
- `serializeTools()` (line 160) — converts live tools to cache format
- Cache path: `~/.pi/agent/mcp-cache.json`

### Panel UI and config write-back

**`mcp-panel.ts`** — Interactive TUI panel. **Not modified in Phase 1.**
- `ToolState` interface (line 84) — per-tool panel state;
  - Existing: `{ name, description, isDirect: boolean, wasDirect: boolean, estimatedTokens }`
  - **Phase 4:** change to `{ name, description, visibility: ToolVisibility, wasVisibility: ToolVisibility, estimatedTokens }`
- `ServerState` interface (line 92) — per-server panel state;
  - **Phase 4:** add `originalDirectTools: true | string[] | false` field
- Constructor (line 133) — builds server/tool tree from config + cache. Initialize visibility and originalDirectTools here.
- `buildResult()` (line 279) — emits changes map on save;
  - **Phase 4:** rewrite for sentinel preservation, hidden tools emission, config-only dirty tracking
- `renderToolRow()` (line 791) — per-tool rendering;
  - Existing: shows ●/○ based on `isDirect`
  - **Phase 4:** show ● (direct), ○ (proxy), ✕ (hidden); add ⚡ marker for env-promoted tools
- `rebuildServerTools()` (line 545) — rebuilds tool list after reconnect;
  - **Phase 4:** preserve visibility state for known tools, default new to PROXY

**How panel connects to config write-back (`commands.ts`, line ~380):**
```
openMcpPanel() 
  → createMcpPanel(config, cache, provenanceMap, callbacks, tui, doneCallback)
    → user saves → doneCallback(result: McpPanelResult)
      → writeDirectToolsConfig(result.changes, provenanceMap, config) [config.ts line 631]
```
The `done` callback receives `McpPanelResult`. The `.changes` map value type changes from `true | string[] | false` to `{ directTools: true | string[] | false; hiddenTools?: string[] }`.

**`commands.ts`** — Command handlers and panel flow orchestration.
- `openMcpPanel()` (line 380) — creates the MCP panel, handles save → config write-back
- `buildMcpPanelCallbacks()` (line 300) — builds callback object passed to panel (reconnect, authenticate, etc.)

**`config.ts`** — Config loading and write-back.
- `writeDirectToolsConfig()` (line 631) — writes direct tool changes back to config files. Extend to handle `hiddenTools` field alongside existing `directTools`. Groups changes by target file path (from provenance).
- `getServerProvenance()` (line 594) — maps server names to their source config files (user, project, import). Determines which file gets written.
- `loadMcpConfig()` (line 183) — loads merged config from all sources. Add startup validation call after this returns.

### Supporting utilities

**`resource-tools.ts`** — Resource name → tool name conversion.
- `resourceNameToToolName()` (line 3) — sanitizes resource names to valid tool identifiers. Used for `get_*` pseudo-tools.

**`utils.ts`** — General helpers.
- `truncateAtWord()` (line 96) — truncates descriptions in proxy output
- `formatAuthRequiredMessage()` (line 109) — formats auth error messages

### Data flow summary (implementation read order)

```
Config load: config.ts → types.ts (McpConfig, ServerEntry shapes)
              ↓
Extension init: index.ts → direct-tools.ts (resolveDirectTools, hidden filter)
              ↓                                    → metadata-cache.ts (cache persistence)
Session start: index.ts → init.ts (initializeMcp, startup validation)
              ↓
Proxy dispatch: index.ts → proxy-modes.ts (inline getToolVisibility calls)
              ↑
Panel flow: commands.ts → mcp-panel.ts → config.ts (writeDirectToolsConfig)
```

### Key invariants to preserve

1. **Visibility is computed, not cached** — `.visibility` on `ToolMetadata` is optional convenience only. The single source of truth is always the live config (`mcpServers[serverName].hiddenTools` + `directTools`).
2. **Original names for resolution** — visibility lookup uses `tool.originalName` (unprefixed), never the prefixed display name.
3. **Hidden wins over everything** — including env override. The security boundary is `hiddenTools` > `MCP_DIRECT_TOOLS` > config `directTools`.
4. **Write-back preserves provenance** — changes go to the correct source file (user vs. project vs. import copy-out) via `getServerProvenance()`.

---

## Handoff Notes (Phase 1 → Phase 2+)

### Current State
- **Working copy:** `~/github/pi-mcp-adapter` (fork of `nicobailon/pi-mcp-adapter`)
- **Branch:** `main`
- **Git history (last 5 commits):**
  ```
  0d0f843 feat(init): startup config validation warns on directTools+hiddenTools overlap
  c4a74cf feat(proxy-modes): filter all 4 proxy ops by visibility — list, search, describe, call
  461032d feat(direct-tools): add getToolVisibility() resolver with priority chain
  828179f feat(types): add ToolVisibility enum, hiddenTools to ServerEntry, .visibility on ToolMetadata
  1091b34 chore: release v2.8.0
  ```
- **Phase 1:** ✅ COMPLETE — core resolver + proxy filtering live and tested
- **Phases 2–5:** ⏳ PENDING

### Quick Status Checks (copy-paste ready)
```bash
cd ~/github/pi-mcp-adapter
# Verify tests pass
git diff --stat HEAD~4          # shows Phase 1 changes: 6 files, ~479 insertions
git log --oneline -5            # should show the 4 commits above
npx vitest run                  # expect: 337 passed, 2 failed (pre-existing, unrelated)
npx tsc --noEmit                # expect: no errors
```

### Recommended Reading Order for Fresh Context
1. **This ADR** — read the full design doc from top to bottom (Problem → Decision → Design → Roadmap → Reference Material). You can skip the code blocks in the design section; they're implementation details. Focus on:
   - Problem Statement
   - Decision (the 3-state table)
   - Phase 1–5 roadmap and what each phase does
   - Handoff Notes section (this section) ← you are here
2. **`types.ts`** — read `ServerEntry`, `ToolVisibility`, `ToolMetadata`, `McpPanelResult`. These types now include the new fields from Phase 1.
3. **`direct-tools.ts`** — read `getToolVisibility()` (line ~47) to understand the resolver and its priority chain, then skim `resolveDirectTools()` (line ~149).
4. **`proxy-modes.ts`** — note that all 4 proxy ops now filter by visibility via inline `getToolVisibility()` calls.
5. **`__tests__/visibility.test.ts`** — confirms resolver behavior.
6. **`__tests__/proxy-filtering.test.ts`** — confirms filtering behavior across all ops.

### What Phase 2 Needs (First Next Step)
File to modify: `direct-tools.ts`
- **Location:** in `resolveDirectTools()` after the existing `isToolExcluded` check, before building each spec
- **Action:** call `getToolVisibility({ config } as McpExtensionState, serverName, tool.name)` and `continue` if hidden. Same for resource tools.
- Also update `buildProxyDescription()` to count only PROXY tools in server summaries (not direct or hidden).
- **No new files needed.** Tests already cover the resolver; add 1–2 tests confirming hidden tools are not registered as direct.

### What Phase 3 Needs
Files: `tool-metadata.ts` and `metadata-cache.ts`
- Add optional `config?` parameter to both `buildToolMetadata()` and `reconstructToolMetadata()`
- When config is provided, call `getToolVisibility()` for each tool/resource and attach `.visibility` field
- Purely additive — no behavior change if config not passed

### What Phase 4 Needs (Largest)
Files: `mcp-panel.ts`, `types.ts`, `config.ts`
- Panel needs to switch from boolean toggle (`isDirect`) to 3-state cycle (`proxy → direct → hidden`)
- Change `ToolState.isDirect: boolean` → `.visibility: ToolVisibility, wasVisibility: ToolVisibility`
- Add sentinel preservation logic in `buildResult()` for `directTools: true`
- Extend `McpPanelResult.changes` type to carry `{ directTools, hiddenTools? }`
- Update `writeDirectToolsConfig()` in config.ts to write both fields

### What Phase 5 Needs
File: `proxy-modes.ts`
- Update `executeStatus()` to show per-state counts (direct/proxy/hidden breakdown) instead of raw tool count
- Verify resource tools (`get_*` pseudo-tools) follow same visibility rules
- Edge case: if all tools on a server are hidden/non-proxy, omit from proxy description entirely

### Test Verification Commands
```bash
cd ~/github/pi-mcp-adapter
# Run only new Phase 1 tests (fast)
npx vitest run __tests__/visibility.test.ts __tests__/proxy-filtering.test.ts --reporter=verbose

# Full suite (includes pre-existing interactive-visualizer failures — ignore those 2)
npx vitest run --reporter=verbose

# Type check after any change
npx tsc --noEmit
```

### Key Files Summary for Remaining Work
| Phase | File | What changes |
|---|---|---|
| 2 | `direct-tools.ts` | Skip hidden in `resolveDirectTools()`, update `buildProxyDescription()` counts |
| 3 | `tool-metadata.ts` | Attach `.visibility` during build |
| 3 | `metadata-cache.ts` | Attach `.visibility` during reconstruct |
| 4 | `mcp-panel.ts` | Switch from boolean to 3-state cycle, sentinel preservation |
| 4 | `types.ts` | Extend `McpPanelResult.changes` type |
| 4 | `config.ts` | Write-back both `directTools` and `hiddenTools` |
| 5 | `proxy-modes.ts` | Visibility-aware status counts in `executeStatus()` |

### Design Decisions That Must Not Change
1. **Hidden wins over everything** — including `MCP_DIRECT_TOOLS` env override
2. **Visibility is computed, not cached** — `.visibility` on ToolMetadata is optional convenience only
3. **Original names for resolution** — never use prefixed display name in visibility lookup
4. **Same error path for hidden tools** through proxy — returns `tool_not_found` (no existence leak)
5. **Phase 1 proxy filtering works without Phase 3 metadata attachment** — inline resolver calls handle it
