# Iconography — Replace Emojis with Material Icons

## Executive Summary

Castle currently uses emoji characters (🤖, 🔬, 🐛, 📁) as agent identity icons. These are stored as plain strings in the `icon` property of the `Agent` interface and rendered directly in `<span>` elements across the UI. This research proposes replacing the default agent emojis with Material Icons while preserving the user's ability to choose *either* a Material Icon or an emoji through a new icon-picker dropdown in the agent edit dialog.

---

## Current State Analysis

### Data Model

**`src/shared/types/agent.types.ts`**
```typescript
export interface Agent {
  icon?: string;    // Currently stores emoji characters like "🤖"
  // ...
}
export interface CastleAgentConfig {
  icon?: string;    // Same — persisted to AGENTS.md YAML config
}
```

The `icon` field is an optional string with no type discrimination between emoji and Material Icon identifiers.

### Default Agent Definitions

**`src/main/services/agent-discovery.service.ts`** — Three hardcoded defaults:

| Agent             | Emoji | Color   |
|-------------------|-------|---------|
| General Assistant | 🤖    | #7C3AED |
| Researcher        | 🔬    | #06B6D4 |
| Debugger          | 🐛    | #EF4444 |

Fallback for workspace agents without config: `📁`  
Fallback for builtin agents without config: `🤖`

### Icon Rendering Locations (5 UI touch points)

| Location | File | How it Renders |
|----------|------|----------------|
| **Sidebar circles** | `agent-circle.component.html:16-20` | `@if (agent().icon)` → `<span class="agent-icon">{{ icon }}</span>`, else `<mat-icon>smart_toy</mat-icon>` |
| **Header toolbar** | `main-layout.component.html:94` | `<span class="agent-icon">{{ agent.icon \|\| '🤖' }}</span>` |
| **Chat message bubbles** | `message-bubble.component.html:6-10` | `@if (agentIcon())` → `<span class="agent-icon">{{ agentIcon() }}</span>`, else `<mat-icon>smart_toy</mat-icon>` |
| **Message list** (pass-through) | `message-list.component.html:7,24` | `[agentIcon]="agentIcon()"` — passes to message-bubble |
| **Chat component** (pass-through) | `chat.component.html:12` | `[agentIcon]="agent().icon"` — passes to message-list |

### Agent Edit Dialog

**`src/app/shared/components/agent-dialog/agent-dialog.component.ts:46-48`**
```html
<mat-form-field appearance="outline" class="icon-field">
  <mat-label>Icon (emoji)</mat-label>
  <input matInput [(ngModel)]="icon" placeholder="🤖" />
</mat-form-field>
```
Currently a plain text input where users type/paste an emoji. No picker, no Material Icon support.

### Icon Persistence

Icons are saved to `AGENTS.md` as YAML (`agent-discovery.service.ts:50`):
```yaml
<!-- castle-config
agents:
  - name: General Assistant
    icon: 🤖
    color: "#7C3AED"
-->
```

### Angular Material Setup

- **Version**: `@angular/material ^17.3.0`
- **Icon font**: Already loaded via `<link>` in `index.html` — `Material+Icons` from Google Fonts
- **MatIconModule**: Already imported in 11+ components
- **MatIconRegistry**: Not used (no custom SVG icons)
- **Existing `<mat-icon>` usage**: 80+ instances across the codebase — the icon font is well-integrated

---

## Proposed Approach

### 1. Icon Value Convention

Introduce a naming convention to distinguish Material Icons from emoji:

| Type | Stored Value | Example |
|------|-------------|---------|
| Material Icon | `mat:icon_name` | `mat:smart_toy` |
| Emoji | Raw emoji character | `🤖` |

**Detection logic** (simple helper function):
```typescript
export function isMatIcon(icon: string): boolean {
  return icon.startsWith('mat:');
}
export function getMatIconName(icon: string): string {
  return icon.replace('mat:', '');
}
```

This approach is backward-compatible — existing emoji values remain valid. Only new defaults and user selections using Material Icons will carry the `mat:` prefix.

### 2. Update Default Agents to Use Material Icons

Replace emoji defaults with Material Icon identifiers:

| Agent             | Current | Proposed |
|-------------------|---------|----------|
| General Assistant | 🤖      | `mat:smart_toy` |
| Researcher        | 🔬      | `mat:science` |
| Debugger          | 🐛      | `mat:bug_report` |
| Workspace fallback| 📁      | `mat:folder` |
| Builtin fallback  | 🤖      | `mat:smart_toy` |

### 3. Update All Rendering Locations

Each rendering location needs a conditional to handle both types. Create a shared component or use `@if` branching:

**Option A — Inline `@if` (simplest, minimal change):**
```html
@if (icon && isMatIcon(icon)) {
  <mat-icon>{{ getMatIconName(icon) }}</mat-icon>
} @else if (icon) {
  <span class="agent-icon">{{ icon }}</span>
} @else {
  <mat-icon>smart_toy</mat-icon>
}
```

**Option B — Shared micro-component (cleaner, DRY):**
```typescript
@Component({
  selector: 'app-agent-icon',
  template: `
    @if (icon() && isMatIcon(icon()!)) {
      <mat-icon>{{ matIconName() }}</mat-icon>
    } @else if (icon()) {
      <span class="emoji-icon">{{ icon() }}</span>
    } @else {
      <mat-icon>smart_toy</mat-icon>
    }
  `
})
export class AgentIconComponent {
  icon = input<string | undefined>();
  isMatIcon = (v: string) => v.startsWith('mat:');
  matIconName = computed(() => this.icon()?.replace('mat:', '') ?? '');
}
```

**Recommendation**: Option B — a shared `AgentIconComponent`. It's used in 3 distinct templates (agent-circle, main-layout header, message-bubble), so a shared component eliminates duplication and makes future icon system changes a single-file edit.

### 4. Build the Icon Picker in Agent Dialog

Replace the plain text `<input>` with a dropdown picker that has two sections:

#### UI Design

```
┌─────────────────────────────┐
│ Icon                    ▼   │
├─────────────────────────────┤
│ ── Material Icons ────────  │
│ [smart_toy] [science]       │
│ [bug_report] [code]         │
│ [terminal] [psychology]     │
│ [build] [settings]          │
│ [search] [analytics]  ...   │
│                             │
│ ── Emoji ──────────────────│
│ 🤖 🔬 🐛 💡 🎯 🛡️ 📊 🔧  │
│ ⚡ 🎨 📝 🧪 🔍 📁 🌐 🧠  │
│                             │
│ ── Custom ─────────────────│
│ [Type emoji...]             │
└─────────────────────────────┘
```

#### Implementation Approach

Use a `mat-menu` triggered by a button (not `mat-select`, since we need a grid layout for icons):

```html
<div class="icon-picker-field">
  <mat-label>Icon</mat-label>
  <button mat-stroked-button [matMenuTriggerFor]="iconMenu" class="icon-preview-btn">
    <app-agent-icon [icon]="icon" />
    <mat-icon>arrow_drop_down</mat-icon>
  </button>
  
  <mat-menu #iconMenu="matMenu" class="icon-picker-menu">
    <div class="icon-grid" (click)="$event.stopPropagation()">
      <h4>Material Icons</h4>
      <div class="icon-options">
        @for (mi of materialIconOptions; track mi) {
          <button mat-icon-button (click)="selectIcon('mat:' + mi)" 
                  [class.selected]="icon === 'mat:' + mi">
            <mat-icon>{{ mi }}</mat-icon>
          </button>
        }
      </div>
      <h4>Emoji</h4>
      <div class="icon-options">
        @for (em of emojiOptions; track em) {
          <button mat-icon-button (click)="selectIcon(em)"
                  [class.selected]="icon === em">
            {{ em }}
          </button>
        }
      </div>
      <mat-form-field appearance="outline" class="custom-emoji-field">
        <mat-label>Custom emoji</mat-label>
        <input matInput [(ngModel)]="customEmoji" placeholder="Paste emoji..." 
               (ngModelChange)="selectIcon($event)" />
      </mat-form-field>
    </div>
  </mat-menu>
</div>
```

#### Curated Icon Lists

**Material Icons** (recommended curated set of ~30-40 relevant icons):
```typescript
export const AGENT_MATERIAL_ICONS = [
  // AI & Technology
  'smart_toy', 'psychology', 'auto_awesome', 'memory', 'hub',
  // Development
  'code', 'terminal', 'bug_report', 'build', 'integration_instructions',
  'data_object', 'developer_mode', 'api',
  // Research & Analysis
  'science', 'search', 'analytics', 'biotech', 'query_stats',
  'troubleshoot', 'manage_search',
  // Tools & Actions
  'handyman', 'construction', 'tune', 'settings', 'engineering',
  // Communication
  'forum', 'chat', 'support_agent', 'record_voice_over',
  // Security & Shield
  'security', 'shield', 'lock', 'verified_user',
  // Files & Data
  'folder', 'description', 'storage', 'inventory',
  // Misc
  'rocket_launch', 'speed', 'bolt', 'star', 'eco', 'palette'
] as const;
```

**Emoji** (curated common set):
```typescript
export const AGENT_EMOJI_OPTIONS = [
  '🤖', '🔬', '🐛', '💡', '🎯', '🛡️', '📊', '🔧',
  '⚡', '🎨', '📝', '🧪', '🔍', '📁', '🌐', '🧠',
  '🚀', '💻', '🔒', '📈', '🎭', '🤝', '⭐', '🔮'
] as const;
```

### 5. Persistence — No Changes Needed

The YAML persistence format already stores `icon` as a plain string. Material Icons will serialize naturally:
```yaml
icon: mat:smart_toy
```
Emoji values will continue to work as-is. No migration needed for existing configs.

---

## Files to Modify

| File | Change |
|------|--------|
| `src/shared/types/agent.types.ts` | No structural changes needed; `icon?: string` handles both formats |
| `src/shared/constants.ts` | Add `AGENT_MATERIAL_ICONS` and `AGENT_EMOJI_OPTIONS` arrays |
| `src/shared/utils/icon.utils.ts` | **New file** — `isMatIcon()`, `getMatIconName()` helpers |
| `src/app/shared/components/agent-icon/agent-icon.component.ts` | **New file** — shared rendering component |
| `src/app/shared/components/agent-dialog/agent-dialog.component.ts` | Replace text input with icon picker (mat-menu grid) |
| `src/app/features/sidebar/agent-circle/agent-circle.component.html` | Use `<app-agent-icon>` instead of inline `@if` |
| `src/app/features/sidebar/agent-circle/agent-circle.component.ts` | Import `AgentIconComponent` |
| `src/app/layout/main-layout.component.html` | Use `<app-agent-icon>` instead of `{{ agent.icon \|\| '🤖' }}` |
| `src/app/layout/main-layout.component.ts` | Import `AgentIconComponent` |
| `src/app/features/chat/message-bubble/message-bubble.component.html` | Use `<app-agent-icon>` instead of inline `@if` |
| `src/app/features/chat/message-bubble/message-bubble.component.ts` | Import `AgentIconComponent` |
| `src/main/services/agent-discovery.service.ts` | Change default icons to `mat:smart_toy`, `mat:science`, `mat:bug_report`, `mat:folder` |

---

## Key Considerations

### Backward Compatibility
- Existing emoji values in AGENTS.md configs and databases will continue to render correctly — the rendering logic falls through to emoji display for any non-`mat:` prefixed string.
- No data migration is required.

### Offline Support
- The Material Icons font is loaded from Google Fonts CDN (`index.html:10`). For Electron/offline use, consider bundling the font locally via `@angular/material`'s prebuilt package or downloading the icon font to `assets/`.
- Current approach works fine when the user has internet on first load (Electron caches fonts).

### Cross-Platform Emoji Rendering
- Emojis render differently across Windows, macOS, and Linux. Material Icons render identically everywhere — this is a benefit of switching defaults.
- Users who prefer emojis can still pick them, accepting platform-specific rendering.

### Icon Font Size
- The Material Icons font loaded from Google Fonts contains **2,000+** icons. We only expose a curated ~35-40 in the picker, but the full set is available if a user manually types a `mat:icon_name` value.

### YAML Serialization
- The `mat:` prefix contains a colon, but since it appears as a YAML value (not a key), it will serialize correctly: `icon: mat:smart_toy`. No quoting needed.

### Performance
- No performance impact. Material Icons are already loaded (used in 80+ places). Adding a `mat-menu` with ~60 icon buttons is trivially light.

### Accessibility
- Material Icons have built-in `aria-hidden="true"` via `<mat-icon>`. The agent circle button already has `matTooltip` with the agent name for screen readers.
- The icon picker grid buttons should include `aria-label` attributes describing each icon.

---

## Implementation Order

1. **Create utility functions** (`icon.utils.ts`) — `isMatIcon()`, `getMatIconName()`
2. **Create `AgentIconComponent`** — shared rendering with Material Icon / emoji branching
3. **Add icon constants** to `constants.ts` — curated Material Icon and emoji lists
4. **Update rendering locations** — replace inline rendering in agent-circle, main-layout, message-bubble with `<app-agent-icon>`
5. **Update agent-dialog** — replace text input with icon picker dropdown (mat-menu grid)
6. **Update default agents** — switch emoji defaults to `mat:` identifiers in agent-discovery.service.ts
7. **Test** — verify rendering in sidebar, header, chat bubbles; verify picker UX; verify YAML persistence round-trip

---

## Complexity Assessment

- **Scope**: Medium — touches ~12 files, 1 new component, 1 new utility file
- **Risk**: Low — additive change with full backward compatibility
- **Dependencies**: None — Angular Material Icons already fully integrated
- **Testing**: Manual verification of icon rendering across all 5 UI locations + picker interaction
