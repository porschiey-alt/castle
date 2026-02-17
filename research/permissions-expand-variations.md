# Permissions: Expand Variations — Research & Analysis

## Problem Statement

The current permission system stores user decisions ("Always Allow" / "Always Deny") at a coarse granularity: **project path + tool kind** (e.g., `read`, `edit`, `execute`). This means a single "Always Allow" on a `read` operation grants blanket read access to *all* files (even outside the project), and a single "Always Allow" on `execute` permits *any* command—including destructive ones.

**Goal:** Make persisted permission grants more specific so users can express rules like:
- "Always allow reading files **in this directory**"
- "Always allow the command `npm install`"
- "Never allow the command `shutdown`"
- "Always allow editing `.ts` files in `src/`"

---

## Current Architecture

### Data Flow

```
ACP Agent → ProcessManager.onPermissionRequest(sessionId, callback)
  → IPC handler checks DB for existing grant (projectPath + toolKind)
  → If grant found: auto-respond (allow_always / reject_always)
  → If not found: broadcast PERMISSION_REQUEST to renderer
  → PermissionDialogComponent shown to user
  → User clicks option → dialogRef.afterClosed()
  → electronService.respondToPermissionRequest(requestId, agentId, optionId, optionKind, toolKind)
  → IPC PERMISSION_RESPONSE handler:
      → processManager.respondToPermission() (forwards to ACP)
      → If "always" choice: databaseService.savePermissionGrant(projectPath, toolKind, granted)
```

### Database Schema (Current)

```sql
CREATE TABLE IF NOT EXISTS permission_grants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_path TEXT NOT NULL,
  tool_kind TEXT NOT NULL,          -- 'read', 'edit', 'delete', 'execute', 'fetch', etc.
  granted INTEGER NOT NULL DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(project_path, tool_kind)   -- ONE grant per tool kind per project
);
```

### Key Types

```typescript
// src/shared/types/settings.types.ts
export interface PermissionGrant {
  id: number;
  projectPath: string;
  toolKind: string;        // 'read' | 'edit' | 'delete' | 'execute' | 'fetch' | ...
  granted: boolean;
  createdAt: string;
}
```

### Available Data in Permission Requests

The ACP SDK provides rich context in each permission request that is **currently unused** for matching:

```typescript
// PermissionDialogData.toolCall (from ACP)
{
  title?: string;            // Human-readable tool name, e.g. "Read file"
  toolCallId: string;        // Unique call identifier
  kind?: string | null;      // Tool category: 'read', 'edit', 'execute', 'fetch', etc.
  locations?: Array<{
    path: string;            // ★ File path or URI being accessed
    line?: number | null;
  }> | null;
  rawInput?: unknown;        // ★ Original command string or parameters object
}
```

**The `locations` and `rawInput` fields provide the specificity needed for granular permissions but are currently discarded during grant persistence.**

### Tool Kind Values

| Kind | Icon | Description |
|------|------|-------------|
| `read` | visibility | File read operations |
| `edit` | edit | File modifications |
| `delete` | delete | File deletion |
| `move` | drive_file_move | File movement |
| `search` | search | Search operations |
| `execute` | terminal | Command execution |
| `fetch` | cloud_download | Network requests |

---

## Proposed Approach

### Core Concept: Scoped Permission Grants

Replace the current flat `(project_path, tool_kind)` key with a richer grant that includes an optional **scope qualifier**. Each grant becomes:

```
(project_path, tool_kind, scope_type, scope_value)
```

Where:
- **scope_type**: What dimension the scope constrains (`'any'`, `'path'`, `'path_prefix'`, `'glob'`, `'command'`, `'command_prefix'`)
- **scope_value**: The specific constraint value (e.g., `'src/**'`, `'npm install'`, `'/home/user/project'`)

### Grant Matching Priority

When a permission request arrives, grants should be matched from **most specific to least specific**:

1. **Exact match** — e.g., command = `npm install` matches grant with `scope_type='command'`, `scope_value='npm install'`
2. **Prefix match** — e.g., path `src/app/foo.ts` matches grant with `scope_type='path_prefix'`, `scope_value='src/app/'`
3. **Glob match** — e.g., path `src/utils/helper.ts` matches grant with `scope_type='glob'`, `scope_value='src/**/*.ts'`
4. **Blanket match** — e.g., `scope_type='any'` (current behavior, kept for backward compat)

If multiple grants match, the **most specific** grant wins. If a specific grant says "deny" but a broader grant says "allow", the specific deny takes precedence.

### Scope Types by Tool Kind

| Tool Kind | Relevant Scope Types | Scope Value Examples |
|-----------|---------------------|----------------------|
| `read` | `path`, `path_prefix`, `glob`, `any` | `src/config.ts`, `src/`, `**/*.json` |
| `edit` | `path`, `path_prefix`, `glob`, `any` | `src/app/`, `**/*.ts` |
| `delete` | `path`, `path_prefix`, `glob`, `any` | `dist/`, `**/*.tmp` |
| `execute` | `command`, `command_prefix`, `any` | `npm install`, `npm`, `git *` |
| `fetch` | `domain`, `url_prefix`, `any` | `api.github.com`, `https://registry.npmjs.org/` |
| `move` | `path_prefix`, `any` | `src/` |
| `search` | `any` | (search is generally low-risk) |

---

## Detailed Design

### 1. Schema Migration

```sql
-- New schema
CREATE TABLE IF NOT EXISTS permission_grants_v2 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_path TEXT NOT NULL,
  tool_kind TEXT NOT NULL,
  scope_type TEXT NOT NULL DEFAULT 'any',   -- 'any', 'path', 'path_prefix', 'glob', 'command', 'command_prefix', 'domain'
  scope_value TEXT NOT NULL DEFAULT '',      -- the constraint value
  granted INTEGER NOT NULL DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(project_path, tool_kind, scope_type, scope_value)
);

CREATE INDEX IF NOT EXISTS idx_permission_grants_v2_lookup
  ON permission_grants_v2(project_path, tool_kind);
```

**Migration strategy:**
- Existing grants in the old table get migrated as `scope_type='any'`, `scope_value=''` to preserve behavior.
- The old table is kept temporarily; a migration function converts rows to the new schema on first startup.

### 2. Updated Type Definitions

```typescript
// src/shared/types/settings.types.ts

export type PermissionScopeType =
  | 'any'
  | 'path'
  | 'path_prefix'
  | 'glob'
  | 'command'
  | 'command_prefix'
  | 'domain'
  | 'url_prefix';

export interface PermissionGrant {
  id: number;
  projectPath: string;
  toolKind: string;
  scopeType: PermissionScopeType;
  scopeValue: string;
  granted: boolean;
  createdAt: string;
}
```

### 3. Grant Matching Logic

A new utility function handles matching with priority:

```typescript
// Pseudocode for the matching algorithm
function findMatchingGrant(
  grants: PermissionGrant[],
  toolKind: string,
  locations: Array<{ path: string }> | null,
  rawInput: unknown
): PermissionGrant | null {

  // Filter grants for this tool kind
  const candidates = grants.filter(g => g.toolKind === toolKind);

  // Score each candidate by specificity (higher = more specific)
  const scored = candidates
    .map(grant => ({ grant, score: matchScore(grant, locations, rawInput) }))
    .filter(({ score }) => score > 0)    // only actual matches
    .sort((a, b) => b.score - a.score);  // most specific first

  return scored.length > 0 ? scored[0].grant : null;
}

function matchScore(grant: PermissionGrant, locations, rawInput): number {
  switch (grant.scopeType) {
    case 'command':
      // Exact command match (for 'execute' kind)
      return normalizeCommand(rawInput) === grant.scopeValue ? 100 : 0;

    case 'command_prefix':
      // Command starts with prefix (e.g., 'npm' matches 'npm install')
      return normalizeCommand(rawInput)?.startsWith(grant.scopeValue) ? 80 : 0;

    case 'path':
      // Exact file path match
      return locations?.some(l => normalizePath(l.path) === grant.scopeValue) ? 100 : 0;

    case 'path_prefix':
      // File is within a directory
      return locations?.every(l => normalizePath(l.path).startsWith(grant.scopeValue)) ? 70 : 0;

    case 'glob':
      // Glob pattern match (e.g., '**/*.ts')
      return locations?.every(l => minimatch(normalizePath(l.path), grant.scopeValue)) ? 60 : 0;

    case 'domain':
      // Network domain match
      return extractDomain(rawInput) === grant.scopeValue ? 90 : 0;

    case 'any':
      // Blanket match (lowest priority)
      return 10;

    default:
      return 0;
  }
}
```

### 4. Permission Dialog Enhancement

When the user clicks "Always Allow" or "Always Deny", instead of immediately saving a blanket grant, present a **scope selection** step:

#### Option A: Inline Scope Selector (Recommended)

Add a dropdown/radio group to the existing dialog that appears when an "Always" option is about to be selected:

```
┌─────────────────────────────────────────┐
│ 🔒 Permission Required                 │
│                                         │
│ Copilot wants to:                       │
│ [terminal] execute                      │
│ `npm install`                           │
│                                         │
│ Apply "Always Allow" to:                │
│ ○ This exact command (`npm install`)    │
│ ○ All `npm` commands                    │
│ ○ All commands (any execute)            │
│                                         │
│  [Allow Once] [Allow Always] [Reject]   │
└─────────────────────────────────────────┘
```

For file operations:
```
┌─────────────────────────────────────────┐
│ 🔒 Permission Required                 │
│                                         │
│ Copilot wants to:                       │
│ [edit] edit                             │
│ `src/app/services/auth.service.ts`      │
│                                         │
│ Apply "Always Allow" to:                │
│ ○ This file only                        │
│ ○ Files in `src/app/services/`          │
│ ○ Files in project directory            │
│ ○ All files (any edit)                  │
│                                         │
│  [Allow Once] [Allow Always] [Reject]   │
└─────────────────────────────────────────┘
```

#### Option B: Two-Step Dialog

Clicking "Always Allow" opens a follow-up dialog asking for scope. Simpler to implement but adds an extra click.

**Recommendation:** Option A is better UX—the scope selector only appears when hovering/focusing an "Always" button, keeping the common flow fast.

### 5. Settings Page Enhancement

The settings page currently shows grants as flat rows like:

```
[edit icon] edit — Always allowed    [X revoke]
[terminal] execute — Always allowed  [X revoke]
```

Enhanced display should show scope details:

```
[edit icon] edit files in src/app/  — Always allowed    [X revoke]
[terminal] npm install              — Always allowed    [X revoke]
[terminal] execute (all commands)   — Always rejected   [X revoke]
[cloud]    fetch api.github.com     — Always allowed    [X revoke]
```

### 6. IPC Changes

The `PERMISSION_RESPONSE` handler needs to accept the new scope data:

```typescript
// Current payload
{ requestId, agentId, optionId, optionKind, toolKind }

// New payload
{ requestId, agentId, optionId, optionKind, toolKind, scopeType, scopeValue }
```

The IPC handler in `src/main/ipc/index.ts` saves the grant with scope:

```typescript
if (projectPath && (optionKind === 'allow_always' || optionKind === 'reject_always')) {
  await databaseService.savePermissionGrant(
    projectPath, toolKind, optionKind === 'allow_always',
    scopeType ?? 'any', scopeValue ?? ''
  );
}
```

### 7. Permission Check Update

The auto-check in `onPermissionRequest` (ipc/index.ts lines 168-188) must switch from a single DB lookup to a scored matching approach:

```typescript
processManagerService.onPermissionRequest(sessionId, async (data) => {
  const projectPath = directoryService.getCurrentDirectory();
  const toolKind = data.toolCall?.kind;
  if (projectPath && toolKind) {
    // Fetch ALL grants for this project + tool kind
    const grants = await databaseService.getPermissionGrantsByToolKind(projectPath, toolKind);
    // Run matching algorithm
    const match = findMatchingGrant(grants, toolKind, data.toolCall?.locations, data.toolCall?.rawInput);
    if (match) {
      const targetKind = match.granted ? 'allow_always' : 'reject_always';
      const fallbackKind = match.granted ? 'allow_once' : 'reject_once';
      const option = data.options.find(o => o.kind === targetKind)
                  || data.options.find(o => o.kind === fallbackKind);
      if (option) {
        processManagerService.respondToPermission(agentId, data.requestId, option.optionId);
        return;
      }
    }
  }
  broadcaster.send(IPC_CHANNELS.PERMISSION_REQUEST, data);
});
```

---

## Security Considerations

### Path Traversal Prevention

- All file paths in grants must be **normalized** (resolve `..`, remove trailing slashes, lowercase on Windows).
- Paths should be validated to be **within the project directory** for `path_prefix` grants. A grant for `src/` must not match `../../etc/passwd`.
- Implementation: use `path.resolve(projectPath, scopeValue)` and verify the result starts with `projectPath`.

### Command Injection Prevention

- `command` scope type should match the **entire command string** exactly.
- `command_prefix` should match on **word boundaries** — `npm` should match `npm install` but not `npmevil`.
- Consider a **command allowlist** approach rather than prefix matching for highest security.
- Dangerous command patterns (`rm -rf /`, `format`, `shutdown`, `:(){ :|:& };:`) should have built-in warnings regardless of grants.

### Scope Escalation Prevention

- A `scope_type='any'` grant should require **explicit confirmation** in the UI (e.g., "This will allow ALL commands in this project").
- The UI should default to the most restrictive scope option being pre-selected.
- Consider never auto-selecting `any` scope for `execute` and `delete` tool kinds.

### Network Access

- For `fetch` operations, extract the domain or URL prefix for scoping.
- Wildcards for network access should be restrictive (no `*` domain matching).

---

## Files Requiring Changes

| File | Change Description |
|------|--------------------|
| `src/shared/types/settings.types.ts` | Add `PermissionScopeType`, update `PermissionGrant` interface |
| `src/main/services/database.service.ts` | Schema migration, update CRUD methods for new columns |
| `src/main/ipc/index.ts` | Update permission check logic, update save handler |
| `src/app/shared/components/permission-dialog/permission-dialog.component.ts` | Add scope selection logic |
| `src/app/shared/components/permission-dialog/permission-dialog.component.html` | Add scope selector UI |
| `src/app/shared/components/permission-dialog/permission-dialog.component.scss` | Style scope selector |
| `src/app/features/settings/settings-page.component.ts` | Display scope in grants list |
| `src/app/features/settings/settings-page.component.html` | Render scope details |
| `src/shared/types/ipc.types.ts` | Update payload types for scope fields |
| `src/app/core/services/electron.service.ts` | Update `respondToPermissionRequest` call signature |
| `src/app/features/main-layout/main-layout.component.ts` | Pass scope data in permission response |
| **New:** `src/shared/utils/permission-matcher.ts` | Grant matching algorithm utility |

---

## Scope Helper: Deriving Scope Options from Request Data

A utility should generate suggested scope options based on the incoming request:

```typescript
function deriveScopeOptions(toolKind: string, toolCall: ToolCallData): ScopeOption[] {
  const options: ScopeOption[] = [];

  if (toolKind === 'execute' && toolCall.rawInput) {
    const cmd = normalizeCommand(toolCall.rawInput);
    options.push({ scopeType: 'command', scopeValue: cmd, label: `This exact command (\`${cmd}\`)` });

    const prefix = cmd.split(/\s+/)[0]; // first word, e.g. 'npm'
    if (prefix !== cmd) {
      options.push({ scopeType: 'command_prefix', scopeValue: prefix, label: `All \`${prefix}\` commands` });
    }
  }

  if (['read', 'edit', 'delete', 'move'].includes(toolKind) && toolCall.locations?.length) {
    const filePath = toolCall.locations[0].path;
    options.push({ scopeType: 'path', scopeValue: filePath, label: `This file only` });

    const dir = filePath.substring(0, filePath.lastIndexOf('/') + 1);
    if (dir) {
      options.push({ scopeType: 'path_prefix', scopeValue: dir, label: `Files in \`${dir}\`` });
    }

    options.push({ scopeType: 'path_prefix', scopeValue: '', label: `Files in project directory` });
  }

  if (toolKind === 'fetch' && toolCall.rawInput) {
    const domain = extractDomain(toolCall.rawInput);
    if (domain) {
      options.push({ scopeType: 'domain', scopeValue: domain, label: `Requests to \`${domain}\`` });
    }
  }

  // Always offer blanket option last
  options.push({ scopeType: 'any', scopeValue: '', label: `All ${toolKind} operations` });

  return options;
}
```

---

## Migration & Backward Compatibility

1. **Database migration** runs automatically on app startup when the schema version changes.
2. Old `permission_grants` rows are migrated to `permission_grants_v2` with `scope_type='any'` and `scope_value=''`.
3. The old table can be dropped after migration or kept as backup.
4. **Sync protocol**: If multi-device sync exists for grants, the new fields must be added to the sync payload. Devices running older versions should ignore unknown fields gracefully.

---

## Phased Implementation Plan

### Phase 1: Schema & Backend (Low risk, no UI change)
- [ ] Add `scope_type` and `scope_value` columns to `permission_grants`
- [ ] Write migration logic
- [ ] Update `PermissionGrant` type
- [ ] Update database CRUD methods
- [ ] Implement `permission-matcher.ts` utility
- [ ] Update IPC grant check to use matcher
- [ ] Unit tests for matcher

### Phase 2: IPC & Data Plumbing
- [ ] Update IPC payload types to include `scopeType` / `scopeValue`
- [ ] Update `PERMISSION_RESPONSE` handler to save scoped grants
- [ ] Update `electronService.respondToPermissionRequest()` signature
- [ ] Update `main-layout.component.ts` dialog result handler

### Phase 3: Permission Dialog UI
- [ ] Add scope selector to permission dialog HTML
- [ ] Implement `deriveScopeOptions()` for dynamic scope suggestions
- [ ] Wire scope selection to the "Always" option flow
- [ ] Style the scope selector

### Phase 4: Settings Page UI
- [ ] Update settings page to display scope info per grant
- [ ] Add filtering/grouping by tool kind or scope
- [ ] Consider an "Add rule" button for manual grant creation

### Phase 5: Hardening
- [ ] Path normalization and traversal prevention
- [ ] Command safety warnings for dangerous patterns
- [ ] E2E tests for permission flows
- [ ] Documentation updates

---

## Open Questions

1. **Glob library**: Should we use `minimatch`, `picomatch`, or a simpler custom matcher for glob patterns? `minimatch` is already common in Node.js ecosystems.
2. **Default scope selection**: When the user clicks "Always Allow", should the most restrictive option be pre-selected, or the broadest? (Recommendation: most restrictive for security.)
3. **Existing blanket grants**: After migration, should existing `any`-scoped grants remain, or should users be prompted to narrow them?
4. **Command normalization**: How deep should command normalization go? Just trim whitespace, or also resolve aliases, normalize paths in arguments, etc.?
5. **Performance**: With many grants per project, should we cache grants in memory to avoid DB queries on every permission request?
