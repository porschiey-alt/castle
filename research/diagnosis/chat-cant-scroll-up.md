## Diagnosis and Suggested Fix

**Bug:** Chat — Can't scroll up  
**Date:** 2026-02-16  
**Component:** `MessageListComponent` (`src/app/features/chat/message-list/`)

---

### Symptoms

1. User cannot scroll up in an agent's chat view — the view snaps back to the bottom.
2. Occurs during **both** streaming/busy states **and** idle/ready states.
3. Intermittently, scrolling up *does* work — the user has not identified what permits it.

---

### Root Cause Analysis

The scroll-to-bottom logic in `MessageListComponent` has **three compounding defects** that fight the user's scroll position.

#### Defect 1 — `ngAfterViewChecked` fires on every change-detection cycle (primary cause)

```typescript
// message-list.component.ts, line 34-38
ngAfterViewChecked(): void {
  if (this.shouldScrollToBottom) {
    this.scrollToBottom();
  }
}
```

`ngAfterViewChecked` is called after **every** Angular change-detection cycle — not just when messages change. Change detection is triggered by **any** browser event: mouse movement, scroll events, clicks, timers, WebSocket messages, Electron IPC callbacks, etc.

Consequence: even when no new content has arrived, any trivial event fires change detection → `ngAfterViewChecked` → `scrollToBottom()` if `shouldScrollToBottom` is `true`. This creates a constant downward pull.

#### Defect 2 — `scroll-behavior: smooth` causes a feedback loop

```scss
// message-list.component.scss, line 13
scroll-behavior: smooth;
```

When `scrollToBottom()` sets `scrollTop = scrollHeight`, the browser **animates** the scroll. During the animation:

- Intermediate `scroll` events fire → `onScroll()` is called.
- Near the end of the animation the scroll position is within the 100 px threshold → `shouldScrollToBottom` is set back to `true`.
- The next change-detection cycle fires `ngAfterViewChecked` → another `scrollToBottom()`.

This creates a **self-reinforcing loop**: every programmatic smooth-scroll re-enables auto-scroll, making it nearly impossible for the user to escape.

#### Defect 3 — Streaming amplifies the problem

During streaming, the `ChatService` updates the `streamingMessage` signal on every incoming chunk. Each signal update triggers Angular change detection, which triggers `ngAfterViewChecked`. Combined with Defects 1 and 2 this means the view is being force-scrolled to the bottom **dozens of times per second** while the agent is responding.

#### Why scrolling up "sometimes" works

When the chat is truly idle — no streaming, no pending timers, no mouse movement triggering change detection — `ngAfterViewChecked` stops firing. The user can scroll freely until the next change-detection cycle re-triggers the auto-scroll. This explains the intermittent nature of the bug.

---

### Suggested Fix

Replace the `ngAfterViewChecked` approach with a **targeted, event-driven** scroll strategy that only auto-scrolls when content actually changes, and properly respects the user's scroll intent.

#### 1. Stop using `ngAfterViewChecked` — use an `effect()` on input signals instead

```typescript
import { Component, input, ElementRef, ViewChild, effect, NgZone } from '@angular/core';

export class MessageListComponent {
  @ViewChild('scrollContainer') private scrollContainer!: ElementRef;

  messages = input<ChatMessage[]>([]);
  streamingMessage = input<StreamingMessage | null>(null);
  agentName = input<string>('Agent');
  agentIcon = input<string | undefined>(undefined);

  private shouldScrollToBottom = true;
  private userScrolledUp = false;
  private lastScrollTop = 0;
  private programmaticScroll = false;

  constructor(private ngZone: NgZone) {
    // Only react when messages or streaming content actually change
    effect(() => {
      // Read signals to register them as dependencies
      this.messages();
      this.streamingMessage();

      // Schedule scroll after the DOM has updated
      if (this.shouldScrollToBottom) {
        requestAnimationFrame(() => this.scrollToBottom());
      }
    });
  }

  onScroll(event: Event): void {
    if (this.programmaticScroll) {
      return; // Ignore scroll events triggered by our own scrollToBottom()
    }

    const el = event.target as HTMLElement;
    const atBottom = el.scrollHeight - el.scrollTop <= el.clientHeight + 100;

    // Detect upward scroll intent
    if (el.scrollTop < this.lastScrollTop) {
      this.userScrolledUp = true;
      this.shouldScrollToBottom = false;
    } else if (atBottom) {
      this.userScrolledUp = false;
      this.shouldScrollToBottom = true;
    }

    this.lastScrollTop = el.scrollTop;
  }

  private scrollToBottom(): void {
    if (this.scrollContainer) {
      const el = this.scrollContainer.nativeElement;
      this.programmaticScroll = true;
      el.scrollTop = el.scrollHeight;
      // Reset the flag after scroll event has been dispatched
      requestAnimationFrame(() => {
        this.programmaticScroll = false;
      });
    }
  }

  trackByMessageId(_index: number, message: ChatMessage): string {
    return message.id;
  }
}
```

Key changes:
- **`effect()`** watches only the `messages` and `streamingMessage` signals. It fires only when content actually changes, not on every change-detection cycle.
- **`programmaticScroll` flag** prevents `onScroll` from misinterpreting programmatic scrolls as user-at-bottom.
- **Upward scroll detection** (`scrollTop < lastScrollTop`) positively detects user intent to scroll up, rather than relying solely on distance-from-bottom.

#### 2. Remove `scroll-behavior: smooth` from the container

```scss
.message-list-container {
  flex: 1;
  overflow-y: auto;
  padding: 16px;
- scroll-behavior: smooth;
  min-height: 0;
}
```

Smooth scrolling on the message container causes the feedback loop described in Defect 2. If smooth auto-scroll is desired, it should be done programmatically with `element.scrollTo({ top: ..., behavior: 'smooth' })` only on non-streaming completions (i.e., when a final message arrives), and **never** during active streaming.

#### 3. Remove `AfterViewChecked` interface and import

Remove the `AfterViewChecked` import and interface implementation from the component class since it is no longer used.

---

### Verification Steps

1. **Scroll up during streaming** — Start a conversation, trigger a long agent response. While the response is streaming, scroll up. The view should remain at the user's scroll position and **not** snap back to the bottom.

2. **Scroll up when idle** — After a response completes, scroll up to review earlier messages. The view should remain stable with no jitter or snap-back on mouse movement, clicks, or other unrelated events.

3. **Auto-scroll on new content at bottom** — If the user is already at the bottom of the chat (within ~100 px), new messages and streaming content should still auto-scroll the view to keep the latest content visible.

4. **Re-engage auto-scroll** — After scrolling up, scroll back down to the bottom. Verify that auto-scroll re-engages and new content is followed.

5. **Agent switch** — Switch between agents. The new agent's chat should display at the bottom. Switch back; the previous position should not cause erratic scrolling.

6. **Empty chat** — Open a chat with no history. Send a first message. Verify auto-scroll works from the start.
