# Material Icons for Agents in Chat Are Broken — Bug Diagnosis

## Diagnosis and Suggested Fix

### Symptoms

In the chat view, the thinking bubble's avatar shows the literal string
`mat:bug_report` (or whatever the `mat:` icon name is) as large text instead of
rendering the actual Material icon glyph. The message bubbles themselves render
icons correctly.

### Root Cause Analysis

**File:** `src/app/features/chat/message-list/message-list.component.html`, lines 33–38

```html
<!-- Thinking bubble avatar -->
<div class="avatar">
  @if (agentIcon()) {
    <span class="agent-icon">{{ agentIcon() }}</span>
  } @else {
    <mat-icon>psychology</mat-icon>
  }
</div>
```

The thinking bubble renders `agentIcon()` with raw string interpolation
(`{{ agentIcon() }}`). When the icon value is `mat:bug_report`, it outputs the
literal text `mat:bug_report` inside a `<span>`.

By contrast, the message bubble template correctly uses the shared
`AgentIconComponent`:

```html
<!-- message-bubble.component.html, line 7 -->
<app-agent-icon [icon]="agentIcon()" />
```

`AgentIconComponent` detects the `mat:` prefix via `isMatIcon()`, strips it with
`getMatIconName()`, and renders a proper `<mat-icon>` element. The thinking bubble
bypasses this component entirely.

Additionally, `AgentIconComponent` is not in the `imports` array of
`MessageListComponent` — only `MatIconModule` and `MessageBubbleComponent` are
imported — so even if the template used `<app-agent-icon>`, Angular would not
recognize the selector.

### Suggested Fix

Replace the raw `<span>` interpolation with `<app-agent-icon>` and add it to the
component imports.

#### 1. Import `AgentIconComponent`

**File:** `src/app/features/chat/message-list/message-list.component.ts`

```diff
 import { MessageBubbleComponent } from '../message-bubble/message-bubble.component';
+import { AgentIconComponent } from '../../../shared/components/agent-icon/agent-icon.component';
 import type { ChatMessage, StreamingMessage } from '../../../../shared/types/message.types';

 @Component({
   imports: [
     CommonModule,
     ScrollingModule,
     MatIconModule,
-    MessageBubbleComponent
+    MessageBubbleComponent,
+    AgentIconComponent
   ],
 })
```

#### 2. Replace the raw span with `<app-agent-icon>`

**File:** `src/app/features/chat/message-list/message-list.component.html`

```diff
       <div class="thinking-bubble">
         <div class="avatar">
-          @if (agentIcon()) {
-            <span class="agent-icon">{{ agentIcon() }}</span>
-          } @else {
-            <mat-icon>psychology</mat-icon>
-          }
+          <app-agent-icon [icon]="agentIcon()" />
         </div>
```

`AgentIconComponent` already handles the three cases:
- `mat:icon_name` → renders `<mat-icon>icon_name</mat-icon>`
- emoji string → renders `<span class="emoji-icon">🔬</span>`
- undefined/empty → renders `<mat-icon>smart_toy</mat-icon>` (fallback)

The `@else` branch with the `psychology` fallback icon is no longer needed because
`AgentIconComponent` provides its own fallback (`smart_toy`). If `psychology` is
preferred as the thinking-bubble fallback, the component could be given a
`fallbackIcon` input — but this is a minor stylistic choice and not required.

### Verification Steps

1. **Material icon agent:** Set an agent icon to a Material icon (e.g.
   `mat:bug_report`). Send a message that triggers thinking. Confirm the thinking
   bubble avatar shows the actual bug_report icon glyph, not the text
   `mat:bug_report`.
2. **Emoji icon agent:** Set an agent icon to an emoji (e.g. `🔬`). Trigger
   thinking. Confirm the emoji renders correctly in the thinking bubble avatar.
3. **No-icon agent:** Use an agent with no icon set. Trigger thinking. Confirm the
   fallback icon (`smart_toy`) renders in the thinking bubble avatar.
4. **Message bubble consistency:** Verify the message bubble avatars still render
   correctly — no regression from this change.
5. **Icon color:** Confirm the icon in the thinking bubble inherits the avatar
   color (via `AgentIconComponent`'s `color: inherit` style).
