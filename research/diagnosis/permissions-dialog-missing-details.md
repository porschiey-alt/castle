## Diagnosis and Suggested Fix

### Symptoms

The permission dialog displays only a generic message like `"AgentName wants to: Execute an action"`. It does not show:

1. **The tool name** — which tool is being invoked (e.g., `edit`, `execute`, `read`).
2. **The command** — the raw input/arguments being passed to the tool.
3. **The file path** — which file(s) the tool is operating on, if applicable.

Users cannot make an informed allow/reject decision without this context.

### Root Cause Analysis

The ACP `RequestPermissionRequest` provides a `toolCall` field of type `ToolCallUpdate`, which contains rich information:

| Field | Type | Description |
|---|---|---|
| `title` | `string \| null` | Human-readable title (e.g., "Edit src/app.ts") |
| `toolCallId` | `string` | Unique ID for the tool call |
| `kind` | `ToolKind \| null` | Category: `"read"`, `"edit"`, `"delete"`, `"execute"`, etc. |
| `locations` | `ToolCallLocation[] \| null` | File paths (with optional line numbers) affected |
| `rawInput` | `unknown` | Raw input parameters sent to the tool |
| `status` | `ToolCallStatus \| null` | Execution status |
| `content` | `ToolCallContent[] \| null` | Content produced by the tool |

**Problem 1 — Data loss in the process manager (backend):**
In `src/main/services/process-manager.service.ts` (lines 147–157), the `requestPermission` handler forwards permission data to the renderer but only passes through two fields from `params.toolCall`:

```typescript
toolCall: params.toolCall,  // passes full object BUT...
```

Actually, the full `params.toolCall` object *is* forwarded. The data is available.

**Problem 2 — The dialog component interface is too narrow (frontend):**
In `src/app/shared/components/permission-dialog/permission-dialog.component.ts` (lines 15–18), the `PermissionDialogData.toolCall` interface only declares:

```typescript
toolCall: {
  title?: string;
  toolCallId: string;
};
```

This discards `kind`, `locations`, and `rawInput` from the type, even though the actual runtime data contains them.

**Problem 3 — The template doesn't render the details (frontend):**
In `permission-dialog.component.html` (lines 6–11), the template only shows:

```html
<p class="agent-name">{{ data.agentName }} wants to:</p>
<code>{{ data.toolCall.title || 'Execute an action' }}</code>
```

It does not display:
- The tool kind (e.g., "edit", "execute", "read")
- File locations from `toolCall.locations`
- The command/raw input from `toolCall.rawInput`

### Suggested Fix

#### 1. Update the `PermissionDialogData` interface to include the missing fields

**File:** `src/app/shared/components/permission-dialog/permission-dialog.component.ts`

```typescript
export interface PermissionDialogData {
  requestId: string;
  agentId: string;
  agentName: string;
  toolCall: {
    title?: string;
    toolCallId: string;
    kind?: string | null;
    locations?: Array<{ path: string; line?: number | null }> | null;
    rawInput?: unknown;
  };
  options: Array<{
    optionId: string;
    name: string;
    kind: string;
  }>;
}
```

#### 2. Update the template to display tool kind, command, and file paths

**File:** `src/app/shared/components/permission-dialog/permission-dialog.component.html`

```html
<h2 mat-dialog-title>
  <mat-icon>security</mat-icon>
  Permission Required
</h2>

<mat-dialog-content>
  <p class="agent-name">{{ data.agentName }} wants to:</p>
  <div class="tool-call-info">
    @if (data.toolCall.kind) {
      <div class="tool-kind">
        <mat-icon>{{ getToolKindIcon(data.toolCall.kind) }}</mat-icon>
        <span class="tool-kind-label">{{ data.toolCall.kind }}</span>
      </div>
    }
    <code>{{ data.toolCall.title || 'Execute an action' }}</code>
  </div>

  @if (data.toolCall.locations?.length) {
    <div class="tool-locations">
      <p class="section-label">Files:</p>
      @for (loc of data.toolCall.locations; track loc.path) {
        <div class="location-item">
          <mat-icon>description</mat-icon>
          <code>{{ loc.path }}@if (loc.line) {:{{ loc.line }}}</code>
        </div>
      }
    </div>
  }

  @if (data.toolCall.rawInput) {
    <div class="tool-command">
      <p class="section-label">Command:</p>
      <code>{{ formatRawInput(data.toolCall.rawInput) }}</code>
    </div>
  }
</mat-dialog-content>

<mat-dialog-actions align="end">
  @for (option of data.options; track option.optionId) {
    <button
      mat-raised-button
      [color]="getColor(option.kind)"
      (click)="selectOption(option.optionId)">
      <mat-icon>{{ getIcon(option.kind) }}</mat-icon>
      {{ option.name }}
    </button>
  }
</mat-dialog-actions>
```

#### 3. Add helper methods to the component class

**File:** `src/app/shared/components/permission-dialog/permission-dialog.component.ts`

```typescript
getToolKindIcon(kind: string): string {
  switch (kind) {
    case 'read': return 'visibility';
    case 'edit': return 'edit';
    case 'delete': return 'delete';
    case 'move': return 'drive_file_move';
    case 'search': return 'search';
    case 'execute': return 'terminal';
    case 'fetch': return 'cloud_download';
    default: return 'build';
  }
}

formatRawInput(rawInput: unknown): string {
  if (typeof rawInput === 'string') return rawInput;
  try {
    return JSON.stringify(rawInput, null, 2);
  } catch {
    return String(rawInput);
  }
}
```

#### 4. Add styles for the new elements

**File:** `src/app/shared/components/permission-dialog/permission-dialog.component.scss`

```scss
.tool-kind {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 8px;

  .tool-kind-label {
    text-transform: capitalize;
    font-weight: 500;
    font-size: 13px;
    opacity: 0.8;
  }

  mat-icon {
    font-size: 16px;
    width: 16px;
    height: 16px;
  }
}

.section-label {
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  opacity: 0.7;
  margin: 12px 0 4px;
}

.tool-locations {
  .location-item {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 0;

    mat-icon {
      font-size: 16px;
      width: 16px;
      height: 16px;
      opacity: 0.7;
    }

    code {
      font-family: 'Fira Code', 'Cascadia Code', monospace;
      font-size: 12px;
    }
  }
}

.tool-command {
  code {
    display: block;
    background-color: var(--bg-tertiary, #1e1e2e);
    border-radius: 4px;
    padding: 8px;
    font-family: 'Fira Code', 'Cascadia Code', monospace;
    font-size: 12px;
    white-space: pre-wrap;
    word-break: break-all;
    max-height: 120px;
    overflow-y: auto;
  }
}
```

### Verification Steps

1. **Trigger a permission request** — Start an agent session and send a message that requires file editing or command execution (e.g., "edit the README" or "run npm install").
2. **Verify the tool kind badge** — The dialog should show an icon and label like "edit" or "execute".
3. **Verify the title** — The human-readable title from the ACP `toolCall.title` should display (e.g., "Edit README.md").
4. **Verify file locations** — If the tool targets a file, it should appear under a "Files:" section with the path (and line number if available).
5. **Verify command/raw input** — If the tool has `rawInput` data (e.g., a shell command), it should appear under a "Command:" section.
6. **Verify fallback** — If `kind`, `locations`, or `rawInput` are absent (null/undefined), the corresponding sections should not render (no empty boxes).
7. **Verify button behavior** — Allow/reject buttons should continue to work as before.
