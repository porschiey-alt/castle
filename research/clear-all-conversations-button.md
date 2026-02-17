# Research: Clear All Conversations Button

## Overview

Add a button to the conversation list panel that allows users to delete all conversations for the currently selected agent in a single action.

## Current Architecture

### Data Flow

```
ConversationListComponent (UI)
  → ConversationService (Angular state management)
    → ElectronService (IPC bridge)
      → Preload / WebSocketAPI (transport)
        → IPC Handlers (main process)
          → DatabaseService (SQLite)
```

### Existing Single-Delete Flow

The app already supports deleting individual conversations through the full stack:

1. **UI** — `ConversationListComponent.deleteConversation()` calls `ConversationService.deleteConversation(id)`
2. **Service** — `ConversationService.deleteConversation()` calls `ElectronService.deleteConversation(id)`, reloads the list, and selects the next conversation if the deleted one was active
3. **Electron Service** — Calls `api.conversations.delete(conversationId)` which invokes IPC channel `conversations:delete`
4. **IPC Handler** — Calls `databaseService.deleteConversation(id)` then broadcasts `SYNC_CONVERSATIONS_CHANGED` with `{ action: 'deleted', conversationId }`
5. **Database** — Deletes messages for the conversation, then deletes the conversation row, then saves

### Key Files

| Layer | File | Relevant Code |
|-------|------|---------------|
| UI Template | `src/app/features/chat/conversation-list/conversation-list.component.html` | Conversation list with per-item delete buttons |
| UI Component | `src/app/features/chat/conversation-list/conversation-list.component.ts` | `deleteConversation()`, `newChat()` |
| UI Styles | `src/app/features/chat/conversation-list/conversation-list.component.scss` | Layout, `.empty-state`, footer styles |
| State Service | `src/app/core/services/conversation.service.ts` | `deleteConversation()`, `loadConversations()`, `clearActive()` |
| Chat Service | `src/app/core/services/chat.service.ts` | `clearHistory()` — clears messages for an agent |
| IPC Bridge | `src/app/core/services/electron.service.ts` | `deleteConversation()` |
| Preload | `src/preload/index.ts` | `conversations.delete()` IPC invocation |
| WebSocket API | `src/app/core/services/websocket-api.ts` | WebSocket equivalent of preload |
| IPC Handlers | `src/main/ipc/index.ts` | `CONVERSATIONS_DELETE` handler |
| Database | `src/main/services/database.service.ts` | `deleteConversation()` — SQL DELETE |
| IPC Types | `src/shared/types/ipc.types.ts` | Channel constants and payload types |
| Conversation Types | `src/shared/types/conversation.types.ts` | `Conversation` interface |
| Confirm Dialog | `src/app/shared/components/confirm-dialog/` | Reusable confirmation modal |

### Existing Patterns

- **Confirmation dialogs** — The app already has a reusable `ConfirmDialogComponent` (Material Dialog) with configurable title, message, confirm/cancel text, and a `color="warn"` confirm button.
- **Cross-device sync** — All conversation mutations broadcast via `SYNC_CONVERSATIONS_CHANGED` so remote browsers stay in sync.
- **Active conversation tracking** — `activeConversationIds` map in IPC handlers tracks which conversation is associated with the current agent session.

## Proposed Approach

### Strategy: Batch Delete via Existing Single-Delete API

The simplest approach loops over the agent's conversations and deletes each one through the existing `deleteConversation` pipeline. This avoids adding new IPC channels, preload methods, WebSocket handlers, or database methods.

**Alternative considered:** A dedicated `deleteAllConversations(agentId)` IPC channel with a single SQL `DELETE FROM conversations WHERE agent_id = ?`. This is more efficient for large conversation counts but requires changes across 6+ files. Given that conversation counts per agent are typically small (< 100), the batch approach is pragmatic for an initial implementation.

### Implementation Plan

#### 1. ConversationListComponent — Add Button & Handler

**Template** (`conversation-list.component.html`):

Add a footer section below the `conversation-items` div, after the `@empty` block, inside the container:

```html
@if (conversations().length > 0) {
  <div class="conversation-list-footer">
    <button 
      mat-button 
      class="clear-all-btn"
      (click)="clearAllConversations()">
      <mat-icon>delete_sweep</mat-icon>
      Clear all
    </button>
  </div>
}
```

**Component** (`conversation-list.component.ts`):

Add `MatDialog` injection and the handler method:

```typescript
import { MatDialog } from '@angular/material/dialog';
import { ConfirmDialogComponent, ConfirmDialogData } from '../../../shared/components/confirm-dialog/confirm-dialog.component';

// In class:
private dialog = inject(MatDialog);

async clearAllConversations(): Promise<void> {
  const conversations = this.conversations();
  if (conversations.length === 0) return;

  const dialogRef = this.dialog.open(ConfirmDialogComponent, {
    data: {
      title: 'Clear All Conversations',
      message: `This will permanently delete all ${conversations.length} conversation(s) and their messages. This cannot be undone.`,
      confirmText: 'Clear All',
      cancelText: 'Cancel',
    } as ConfirmDialogData,
    width: '400px',
  });

  const confirmed = await dialogRef.afterClosed().toPromise();
  if (!confirmed) return;

  for (const conv of conversations) {
    await this.conversationService.deleteConversation(conv.id);
  }
}
```

Add `MatDialogModule` to the imports array.

**Styles** (`conversation-list.component.scss`):

```scss
.conversation-list-footer {
  flex-shrink: 0;
  padding: 8px;
  border-top: 1px solid var(--border-color, rgba(255, 255, 255, 0.1));
}

.clear-all-btn {
  width: 100%;
  font-size: 12px;
  color: var(--text-muted);
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 4px;

  mat-icon {
    font-size: 16px;
    width: 16px;
    height: 16px;
  }

  &:hover {
    color: var(--warn-color, #f44336);
  }
}
```

#### 2. ConversationService — Add `deleteAllConversations` Method

```typescript
async deleteAllConversations(agentId: string): Promise<void> {
  const conversations = this.conversations();
  for (const conv of conversations) {
    await this.electronService.deleteConversation(conv.id);
  }

  // Reload and clear active
  await this.loadConversations(agentId);
  this.activeConversationIdSignal.set(null);
}
```

If this method is added, the component can be simplified to call `conversationService.deleteAllConversations(agentId)` instead of looping itself.

#### 3. No Backend Changes Required

The existing `CONVERSATIONS_DELETE` IPC channel and `DatabaseService.deleteConversation()` handle the actual deletion. Each call also broadcasts `SYNC_CONVERSATIONS_CHANGED`, ensuring cross-device sync works.

### Future Optimization: Bulk Delete Endpoint

If performance becomes an issue (many conversations), add:

| Layer | Change |
|-------|--------|
| `ipc.types.ts` | Add `CONVERSATIONS_DELETE_ALL: 'conversations:deleteAll'` channel |
| `database.service.ts` | Add `deleteAllConversations(agentId)` — `DELETE FROM messages WHERE conversation_id IN (SELECT id FROM conversations WHERE agent_id = ?)` then `DELETE FROM conversations WHERE agent_id = ?` |
| `ipc/index.ts` | Register handler for new channel |
| `preload/index.ts` | Add `deleteAll(agentId)` to conversations API |
| `websocket-api.ts` | Add matching method |
| `electron.service.ts` | Add `deleteAllConversations(agentId)` |
| `conversation.service.ts` | Call new electron method |

## Considerations

### UX

- **Button placement** — Bottom of the conversation list panel, visible only when conversations exist. This follows a common pattern (e.g., browser history clear button).
- **Confirmation required** — Destructive action must show the `ConfirmDialogComponent` with a count of conversations being deleted. Confirm button should use `color="warn"`.
- **Visual design** — Subtle, muted button that highlights on hover with a warn color. Uses `delete_sweep` Material icon.
- **Empty state** — Button hides when there are zero conversations; the empty state already has its own messaging.

### State Management

- After clearing, `activeConversationIdSignal` must be set to `null`.
- The `ChatService` will automatically show an empty message list because `loadHistory` returns nothing when there's no active conversation.
- The `activeConversationIds` map in the IPC handler (main process) will be cleaned up naturally when the next message is sent (it checks/sets per `sendMessage`).

### Cross-Device Sync

- Each individual `deleteConversation` call broadcasts `SYNC_CONVERSATIONS_CHANGED`. For N conversations, this fires N events. Remote clients will reload their conversation list N times.
- For the batch approach, this is acceptable for typical conversation counts. The bulk endpoint (future optimization) would emit a single sync event.

### Edge Cases

- **Deleting while streaming** — If an agent is actively streaming a response, the conversation it's writing to gets deleted. The stream will complete and try to save an assistant message with a now-deleted `conversationId`. The message save will still succeed (messages table doesn't enforce FK), but it'll be orphaned. Consider checking if the agent is busy and either warning the user or canceling the stream first.
- **Concurrent deletion** — If two devices trigger clear-all simultaneously, some deletes may fail silently (conversation already deleted). This is safe — `DELETE WHERE id = ?` on a missing row is a no-op.
- **ACP session IDs** — Some conversations store `acpSessionId` for session resumption. Deleting all conversations means the agent won't be able to resume any previous ACP session. This is expected behavior for a "clear all" action.

## Summary

The minimal implementation requires changes to **3 files** (conversation list component, template, and styles), plus optionally **1 file** (ConversationService for a cleaner API). No backend changes are needed since the existing single-delete pipeline is reused. A confirmation dialog using the existing `ConfirmDialogComponent` prevents accidental data loss.
