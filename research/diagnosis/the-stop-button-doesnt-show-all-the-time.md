## Diagnosis and Suggested Fix

**Bug:** The stop button doesn't show all the time  
**Date:** 2026-02-16  
**Components:** `ChatService`, `ChatInputComponent`, `TaskListComponent`

---

### Symptoms

1. When an agent is actively working (streaming response visible in chat), the Stop button does not appear in the chat input area.
2. This happens specifically when the work was initiated from the Tasks view — research, implementation, or review revision — rather than by typing a message directly in the chat.
3. The textarea is correctly disabled (the user can't type), but the Send button is shown instead of the Stop button, giving no way to cancel the operation.

---

### Root Cause Analysis

#### The stop button is gated solely on `isLoading`

In `chat-input.component.html` (line 16):

```html
@if (isLoading()) {
  <button class="stop-button" (click)="onStop()">...</button>
} @else {
  <button (click)="onSend()" [disabled]="...">...</button>
}
```

The stop button is shown **only** when `ChatService.isLoading` is `true`.

#### `isLoading` is only set to `true` by `ChatService.sendMessage()`

```typescript
// chat.service.ts, line 113-114
async sendMessage(agentId: string, content: string): Promise<void> {
  this.setLoading(agentId, true);  // ← the ONLY place isLoading becomes true
  ...
}
```

This is the **only** code path that sets `isLoading = true`. It is called when the user sends a message through the chat UI.

#### Task-initiated operations bypass `ChatService.sendMessage()`

All three task operations use different code paths that never touch `isLoading`:

| Operation | Code path | Sets `isLoading`? |
|-----------|-----------|:-:|
| **Research** | `TaskService.runResearch()` → `ElectronService.runTaskResearch()` | ❌ |
| **Implementation** | `TaskListComponent` → `ElectronService.sendMessage()` directly | ❌ |
| **Review revision** | `TaskService.submitResearchReview()` → `ElectronService.submitResearchReview()` | ❌ |

For **implementation** specifically (`task-list.component.ts`, line 181):

```typescript
// Calls electronService.sendMessage() directly, bypassing ChatService
await this.electronService.sendMessage(event.agentId, prompt);
```

This bypasses `ChatService.sendMessage()`, so `isLoading` is never set to `true` for the target agent.

#### Streaming chunks arrive but don't enable the stop button

When the backend starts streaming responses, `ChatService.setupStreamingListeners()` handles chunks:

```typescript
// chat.service.ts, line 62-71
this.electronService.streamChunk$.subscribe((chunk: StreamingMessage) => {
  this.updateStreamingMessage(chunk.agentId, chunk);   // ✅ streaming bubble appears
  this.agentService.updateSessionStatus(chunk.agentId, 'busy'); // ✅ textarea disables
  // ❌ isLoading is NOT set to true — stop button stays hidden
});
```

The streaming message renders in the chat (the user can see the agent is working), the textarea is disabled (session status becomes `'busy'`), but the stop button never appears because `isLoading` remains `false`.

#### The `streamComplete$` handler sets `isLoading = false` unconditionally

```typescript
// chat.service.ts, line 78
this.setLoading(message.agentId, false);
```

This is harmless (setting `false` when already `false`), but confirms the symmetry is broken — the "off" path exists without a corresponding "on" path for externally-initiated work.

---

### Suggested Fix

Set `isLoading = true` in the `streamChunk$` handler so that **any** streaming activity — regardless of how it was initiated — enables the stop button.

#### Change in `ChatService.setupStreamingListeners()`

```typescript
// chat.service.ts — streamChunk$ handler
this.electronService.streamChunk$.subscribe((chunk: StreamingMessage) => {
  this.updateStreamingMessage(chunk.agentId, chunk);

  // Update todo items if present
  if (chunk.todoItems && chunk.todoItems.length > 0) {
    this.updateTodoItems(chunk.agentId, chunk.todoItems);
  }

  // Ensure loading state is true so the stop button is visible
  this.setLoading(chunk.agentId, true);    // ← ADD THIS LINE

  // Update agent session status to busy
  this.agentService.updateSessionStatus(chunk.agentId, 'busy');
});
```

This is a **one-line fix**. It is safe because:

- `setLoading(true)` is idempotent — calling it multiple times (once per chunk) has no adverse effect.
- The existing `streamComplete$` handler already calls `setLoading(agentId, false)`, so the stop button will correctly disappear when the agent finishes.
- The existing `cancelMessage()` method already calls `setLoading(agentId, false)`, so clicking Stop will correctly clear the state.
- For the normal chat-send flow, `isLoading` is already `true` before chunks arrive, so this is a no-op.

#### Why not change the task-initiated code paths instead?

An alternative would be to have `TaskListComponent` call `chatService.sendMessage()` instead of `electronService.sendMessage()`, or to manually set loading state before starting research. However:

- **Research and review** don't go through the chat send API at all — they use dedicated IPC channels (`runTaskResearch`, `submitResearchReview`). There is no `ChatService` method to call.
- Fixing this at the streaming layer is **universal** — it covers all current and future code paths that produce streaming output, including any that may be added later.

---

### Verification Steps

1. **Research from task view:** Open a task, start research from the Research tab, then switch to the agent's Chat view. The stop button should appear while the agent is streaming.

2. **Implementation from task view:** Open a task, click "Start Implementation." The app switches to the agent's Chat view. The stop button should appear while the agent is working.

3. **Review revision from task view:** Submit review comments on research. Navigate to the agent's Chat view. The stop button should appear while the revision is streaming.

4. **Normal chat still works:** Send a message directly in chat. The stop button should appear immediately (as before) and disappear when the response completes.

5. **Stop button clears on completion:** For each scenario above, let the agent finish. The stop button should be replaced by the send button, and the textarea should re-enable.

6. **Stop button works when clicked:** For each scenario above, click Stop while the agent is working. The agent should cancel, the stop button should disappear, and the textarea should re-enable.
