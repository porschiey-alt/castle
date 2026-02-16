# Research: Manage Agents — Add, Edit, Remove

## Executive Summary

Castle currently discovers agents by parsing `agents.md` files (builtin and workspace) at startup. The sidebar has an "Add Agent" button that emits an event but only logs `"Add agent feature coming soon"`. This research analyzes the architecture and proposes an approach for full agent CRUD: adding new agents, editing existing ones, and removing agents—all backed by persistence to the `agents.md` file.

---

## Current Architecture

### Data Flow

```
resources/agents.md  ──┐
                        ├── AgentDiscoveryService.discoverAgents()
workspace/AGENTS.md  ──┘           │
                                   ▼
                        IPC: agents:discover
                                   │
                                   ▼
                        AgentService (renderer)
                                   │
                                   ▼
                        Sidebar → AgentCircle components
```

### Key Files

| Layer | File | Role |
|-------|------|------|
| **Types** | `src/shared/types/agent.types.ts` | `Agent` interface (id, name, description, icon, color, systemPrompt, source) |
| **Types** | `src/shared/types/ipc.types.ts` | IPC channel definitions; currently only has `AGENTS_DISCOVER`, `AGENTS_GET_ALL`, session channels |
| **Main** | `src/main/services/agent-discovery.service.ts` | Parses `agents.md` `<!-- castle-config -->` YAML blocks into `Agent[]` |
| **Main** | `src/main/services/database.service.ts` | SQLite persistence; has `saveAgent()` and `getAgent()` but no `deleteAgent()` |
| **Main** | `src/main/ipc/index.ts` | IPC handlers; caches discovered agents in-memory, saves to DB |
| **Preload** | `src/preload/index.ts` | Exposes `agents.discover/startSession/stopSession/getSession` |
| **Renderer** | `src/app/core/services/electron.service.ts` | Angular bridge to preload API |
| **Renderer** | `src/app/core/services/agent.service.ts` | Signal-based state management; `discoverAgents()`, `selectAgent()` |
| **Renderer** | `src/app/features/sidebar/sidebar.component.ts` | Emits `addAgentClicked` output event |
| **Renderer** | `src/app/layout/main-layout.component.ts` | Has `addAgent()` method (TODO stub), handles sidebar events |
| **Config** | `resources/agents.md` | Builtin agents config using `<!-- castle-config -->` YAML block |

### agents.md Format

```markdown
<!-- castle-config
agents:
  - name: General Assistant
    icon: 🤖
    color: "#7C3AED"
    description: All-purpose coding help

  - name: Researcher
    icon: 🔬
    color: "#06B6D4"
    description: Researches tasks and produces detailed analysis documents
    systemPrompt: |
      You are a research specialist...
-->
```

The `AgentDiscoveryService` has a custom YAML-like parser (`parseYamlLikeConfig`) that reads this format. There is currently **no serializer** (write-back) capability.

### Existing Dialog Pattern

The app already uses `MatDialog` for:
- **AboutDialogComponent** — simple info dialog
- **PermissionDialogComponent** — action dialog with data injection via `MAT_DIALOG_DATA`

These provide a clear pattern to follow for an agent management dialog.

---

## Proposed Approach

### 1. Agent Dialog Component (Add / Edit)

Create a new `AgentDialogComponent` that serves both add and edit flows:

**Location:** `src/app/shared/components/agent-dialog/`

**Files:**
- `agent-dialog.component.ts`
- `agent-dialog.component.html`
- `agent-dialog.component.scss`

**Dialog Data Interface:**
```typescript
export interface AgentDialogData {
  mode: 'add' | 'edit';
  agent?: Agent;  // Populated for edit mode
}

export interface AgentDialogResult {
  action: 'save' | 'delete';
  agent: Partial<Agent>;
}
```

**Form Fields:**
| Field | Control | Validation | Notes |
|-------|---------|------------|-------|
| Name | Text input | Required, unique among agents | Display name |
| Icon | Emoji picker or text input | Optional | Single emoji character |
| Color | Color picker (hex input) | Optional, default from `BUILTIN_AGENT_COLORS` | Circle color |
| Description | Text input | Optional | Short description shown in tooltip |
| System Prompt | Textarea (multiline) | Optional | Custom instructions for the agent |

**UI Approach:**
- Use Angular Material form controls (`MatFormFieldModule`, `MatInputModule`)
- For color: a simple text input with hex validation and a preview swatch; could use a small preset color palette from `BUILTIN_AGENT_COLORS`
- For icon: a text input accepting emoji (simple approach) — a full emoji picker can be added later
- In edit mode, show a "Delete Agent" button with confirmation
- Dialog width: ~500px, consistent with existing dialogs

### 2. New IPC Channels

Add three new IPC channels to `src/shared/types/ipc.types.ts`:

```typescript
// In IPC_CHANNELS:
AGENTS_SAVE: 'agents:save',      // Add or update an agent
AGENTS_DELETE: 'agents:delete',  // Remove an agent
```

**Payload types:**
```typescript
[IPC_CHANNELS.AGENTS_SAVE]: {
  request: { agent: Omit<Agent, 'id'> & { id?: string } };
  response: Agent;
};
[IPC_CHANNELS.AGENTS_DELETE]: {
  request: { agentId: string };
  response: void;
};
```

### 3. agents.md Serialization (Write-Back)

Add a `serializeAgentsMd()` method to `AgentDiscoveryService` that regenerates the `<!-- castle-config -->` block:

```typescript
serializeAgentsMd(agents: Agent[]): string {
  // Generate the castle-config YAML block
  // Preserve any non-config markdown content in the file
  // Write back to the appropriate agents.md file
}
```

**Approach:**
- Read existing file content
- Replace the `<!-- castle-config ... -->` block with regenerated YAML
- Preserve any markdown content outside the config block
- Write the file back

**Key decision: Where to persist?**

| Option | Pros | Cons |
|--------|------|------|
| **A. Builtin `resources/agents.md`** | Single source of truth; consistent with current discovery | Modifying app resources; won't work in packaged production builds |
| **B. Workspace `AGENTS.md`** | Per-project customization; safe to modify | Requires open workspace; not global |
| **C. User-data config file (new)** | Global user agents; works without workspace | New discovery path needed; separate from agents.md pattern |
| **D. Database only** | Already partially implemented | Agents lost on re-discovery; not portable |

**Recommended: Hybrid approach (B + C)**

- **Workspace agents:** Stored in workspace `AGENTS.md`, editable per-project
- **User agents:** Stored in a user-data `agents.md` (e.g., `%APPDATA%/castle/agents.md`), global
- **Builtin agents:** Read-only from `resources/agents.md`; cannot be edited or deleted through the UI, but can be overridden by workspace/user agents

**Simpler alternative for v1: Database-backed with agents.md export**

For a first implementation, the simplest approach:
1. All agent CRUD operations go through the database (already has `saveAgent`)
2. Add a `deleteAgent()` to `DatabaseService`
3. `discoverAgents()` merges file-discovered agents with DB-stored custom agents
4. The `source` field gets a new value: `'custom'`
5. Optionally: add an "Export to agents.md" feature later

This avoids the complexity of file serialization while still being fully functional.

### 4. Backend Changes (Main Process)

#### `database.service.ts`
```typescript
// Add:
async deleteAgent(agentId: string): Promise<void> {
  this.db.run('DELETE FROM agents WHERE id = ?', [agentId]);
  this.saveDatabase();
}

async getCustomAgents(): Promise<Agent[]> {
  // Return agents with source = 'custom'
}
```

#### `agent-discovery.service.ts`
- Add `serializeAgentsMd()` method (if going with file persistence)
- Or: no changes if using database-only approach for v1

#### `ipc/index.ts`
Register new handlers:
```typescript
ipcMain.handle(IPC_CHANNELS.AGENTS_SAVE, async (_event, { agent }) => {
  const agentWithId = { ...agent, id: agent.id || uuidv4() };
  await databaseService.saveAgent(agentWithId);
  discoveredAgents.set(agentWithId.id, agentWithId);
  return agentWithId;
});

ipcMain.handle(IPC_CHANNELS.AGENTS_DELETE, async (_event, { agentId }) => {
  await databaseService.deleteAgent(agentId);
  discoveredAgents.delete(agentId);
  // Also stop any active session
  const session = processManagerService.getSessionByAgentId(agentId);
  if (session) await processManagerService.stopSession(session.session.id);
});
```

### 5. Preload / ElectronAPI Changes

#### `preload/index.ts`
Add to `agents` section:
```typescript
save: (agent: Omit<Agent, 'id'> & { id?: string }) =>
  ipcRenderer.invoke(IPC_CHANNELS.AGENTS_SAVE, { agent }),
delete: (agentId: string) =>
  ipcRenderer.invoke(IPC_CHANNELS.AGENTS_DELETE, { agentId }),
```

#### `ElectronAPI` interface
Add corresponding type definitions.

### 6. Renderer Service Changes

#### `electron.service.ts`
```typescript
async saveAgent(agent: Omit<Agent, 'id'> & { id?: string }): Promise<Agent | null> {
  if (!this.api) return null;
  return this.api.agents.save(agent);
}

async deleteAgent(agentId: string): Promise<void> {
  if (!this.api) return;
  return this.api.agents.delete(agentId);
}
```

#### `agent.service.ts`
```typescript
async addAgent(agentData: Omit<Agent, 'id' | 'source'>): Promise<void> {
  const saved = await this.electronService.saveAgent({ ...agentData, source: 'custom' });
  if (saved) {
    this.agentsSignal.update(agents => [...agents, saved]);
  }
}

async updateAgent(agent: Agent): Promise<void> {
  const saved = await this.electronService.saveAgent(agent);
  if (saved) {
    this.agentsSignal.update(agents =>
      agents.map(a => a.id === saved.id ? saved : a)
    );
  }
}

async removeAgent(agentId: string): Promise<void> {
  await this.electronService.deleteAgent(agentId);
  this.agentsSignal.update(agents => agents.filter(a => a.id !== agentId));
  
  // If removed agent was selected, select first remaining
  if (this.selectedAgentIdSignal() === agentId) {
    const remaining = this.agentsSignal();
    if (remaining.length > 0) {
      await this.selectAgent(remaining[0].id);
    } else {
      this.selectedAgentIdSignal.set(null);
    }
  }
}
```

### 7. Main Layout Integration

#### `main-layout.component.ts`
Replace the TODO stub:
```typescript
addAgent(): void {
  const dialogRef = this.dialog.open(AgentDialogComponent, {
    width: '500px',
    data: { mode: 'add' } as AgentDialogData,
    panelClass: 'agent-dialog'
  });

  dialogRef.afterClosed().subscribe(async (result: AgentDialogResult) => {
    if (result?.action === 'save') {
      await this.agentService.addAgent(result.agent);
    }
  });
}
```

### 8. Edit Agent Entry Point

The edit flow needs a trigger. Options:

| Option | Description |
|--------|-------------|
| **Right-click context menu** on agent circle | Discord-like UX; familiar pattern |
| **Long-press** on agent circle | Mobile-friendly but less discoverable on desktop |
| **Edit button** in the toolbar when agent is selected | Visible but takes toolbar space |
| **Settings menu** item "Edit Agent" | Consistent with existing settings pattern |

**Recommended: Right-click context menu + toolbar edit button**

Add a `MatMenuModule` context menu to `AgentCircleComponent`:
```html
<button mat-fab
  (click)="onSelect()"
  (contextmenu)="onContextMenu($event)">
  ...
</button>

<mat-menu #agentMenu="matMenu">
  <button mat-menu-item (click)="editAgent.emit(agent())">
    <mat-icon>edit</mat-icon> Edit Agent
  </button>
  <button mat-menu-item (click)="deleteAgent.emit(agent())">
    <mat-icon>delete</mat-icon> Remove Agent
  </button>
</mat-menu>
```

The edit/delete events bubble up through the sidebar to the main layout, which opens the dialog.

---

## Agent Type Considerations

### Source Field Extension

Currently `source: 'builtin' | 'workspace'`. Extend to:
```typescript
source: 'builtin' | 'workspace' | 'custom';
```

- **builtin**: Read from `resources/agents.md`. Not editable/deletable (or show warning).
- **workspace**: Read from workspace `AGENTS.md`. Editable if file is writable.
- **custom**: User-created via UI. Full CRUD.

### Editing Builtin Agents

Two options:
1. **Disallow**: Gray out edit/delete for builtin agents
2. **Override**: Create a custom copy that overrides the builtin (by name match in discovery)

Recommend option 2 for flexibility, with a visual indicator that the agent is overriding a builtin.

---

## Edge Cases & Considerations

1. **Agent name uniqueness**: Enforce unique names (case-insensitive) since discovery uses name as override key
2. **Active session handling**: When deleting an agent with an active session, stop the session first and clear chat view
3. **Selected agent deletion**: If the currently selected agent is deleted, auto-select another or show empty state
4. **Empty agent list**: Already handled in sidebar with "No agents found" state
5. **Color validation**: Validate hex color format (`#RRGGBB`)
6. **System prompt size**: No hard limit, but consider a character count indicator in the textarea
7. **Emoji validation**: Allow any single emoji character or short text for icon field
8. **Concurrent editing**: If two windows could edit agents.md simultaneously (unlikely in Electron single-window), consider file locking
9. **agents.md sync**: If using file persistence, changes made externally to agents.md should be picked up on next discovery (already the case since discovery re-reads files)
10. **Database vs. file divergence**: If database stores custom agents and discovery only reads files, need to merge both sources in `discoverAgents()`

---

## Implementation Order

### Phase 1: Core CRUD (Minimum Viable)

1. **Add `source: 'custom'`** to Agent type
2. **Add `AGENTS_SAVE` and `AGENTS_DELETE`** IPC channels and types
3. **Add `deleteAgent()`** to `DatabaseService`
4. **Register new IPC handlers** in `ipc/index.ts`
5. **Extend preload API** with `save` and `delete`
6. **Extend `ElectronService`** with `saveAgent` and `deleteAgent`
7. **Extend `AgentService`** with `addAgent`, `updateAgent`, `removeAgent`
8. **Merge custom agents in discovery**: Modify `AGENTS_DISCOVER` handler to load DB custom agents and merge them into the result
9. **Create `AgentDialogComponent`** (form with name, icon, color, description, systemPrompt)
10. **Wire up `addAgent()`** in `MainLayoutComponent` to open the dialog

### Phase 2: Edit & Delete

11. **Add context menu** to `AgentCircleComponent` for edit/delete
12. **Wire up edit flow**: Open dialog in edit mode with existing agent data
13. **Wire up delete flow**: Confirmation dialog → remove agent
14. **Handle active session cleanup** on delete

### Phase 3: Polish

15. **Color picker preset palette** from `BUILTIN_AGENT_COLORS`
16. **Builtin agent override** indicator
17. **Export to agents.md** functionality
18. **Keyboard shortcuts** (e.g., `Ctrl+N` for new agent)
19. **Drag-and-drop reorder** of agents in sidebar

---

## Complexity Assessment

| Component | Estimated Effort | Risk |
|-----------|-----------------|------|
| Agent Dialog Component | Medium | Low — follows existing dialog patterns |
| IPC Channels + Handlers | Low | Low — straightforward extension |
| Database changes | Low | Low — simple CRUD |
| Preload/ElectronService | Low | Low — boilerplate |
| AgentService state management | Medium | Medium — signal updates, edge cases |
| Context menu for edit/delete | Low | Low — MatMenu already in use |
| agents.md serialization | Medium-High | Medium — YAML generation, file preservation |
| Discovery merge with custom agents | Medium | Medium — ordering, dedup logic |

**Overall: Medium complexity.** The main risk is in agent discovery merge logic and ensuring custom agents persist correctly across app restarts.

---

## Dependencies

- `@angular/material` — Already installed (MatDialog, MatFormField, MatInput, MatMenu)
- `uuid` — Already installed (for generating agent IDs)
- No new dependencies required

---

## Open Questions

1. Should custom agents be global (user-level) or per-workspace? **Recommendation: Global (database-backed) for v1**
2. Should editing a builtin agent create an override or modify the builtin? **Recommendation: Create override**
3. Should we support agents.md file write-back in v1 or defer? **Recommendation: Defer to Phase 3**
4. Should the delete action have a confirmation dialog or undo? **Recommendation: Confirmation dialog**
5. Should the agent dialog support MCP server configuration? **Recommendation: Defer — the `mcpServers` field exists in the type but isn't used in the config parser yet**
