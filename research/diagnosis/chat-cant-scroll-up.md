# Chat: Can't Scroll Up — Bug Diagnosis

## Diagnosis and Suggested Fix

### Symptoms

- User cannot scroll up in the agent chat view; the view snaps back to the bottom.
- Occurs during both streaming/busy and idle/ready states (though worse during streaming).
- Scrolling up occasionally works — the user hasn't identified what permits it.

### Root Cause Analysis

The bug originates in `src/app/features/chat/message-list/message-list.component.ts`. Three interacting factors combine to prevent the user from scrolling up.

#### Factor 1 (Primary): `ngAfterViewChecked` fires on every change detection cycle

```typescript
// message-list.component.ts — current code
export class MessageListComponent implements AfterViewChecked {
  private shouldScrollToBottom = true;

  ngAfterViewChecked(): void {
    if (this.shouldScrollToBottom) {
      this.scrollToBottom();
    }
  }
}
```

`ngAfterViewChecked` is called after **every** Angular change detection cycle — not just when chat content changes. During streaming, each chunk updates signals in `ChatService`, which triggers change detection. This means `scrollToBottom()` can fire **dozens of times per second** as long as `shouldScrollToBottom` is `true`.

#### Factor 2: Race condition with the 100 px "near-bottom" threshold

```typescript
onScroll(event: Event): void {
  const element = event.target as HTMLElement;
  const atBottom = element.scrollHeight - element.scrollTop <= element.clientHeight + 100;
  this.shouldScrollToBottom = atBottom;
}
```

When the user scrolls up, each mouse-wheel tick moves ~30–100 px. The sequence is:

1. User scrolls up by ~50 px (one wheel tick).
2. `onScroll` fires: `scrollHeight − scrollTop` is still within `clientHeight + 100` → `shouldScrollToBottom` remains `true`.
3. The very next change-detection cycle (possibly the same animation frame) calls `ngAfterViewChecked` → `scrollToBottom()` snaps back to the bottom.
4. The user's next wheel tick faces the same fight — they can never escape the 100 px zone.

This explains why scrolling **sometimes** works: when the chat is idle, change-detection cycles are infrequent enough that the user can accumulate enough scroll distance (> 100 px) between checks.

#### Factor 3 (Exacerbating): `scroll-behavior: smooth` on the container

```scss
// message-list.component.scss
.message-list-container {
  scroll-behavior: smooth;   // ← problematic
}
```

With smooth scrolling enabled, a programmatic `scrollTop = scrollHeight` assignment is **animated**, not instant. During the animation:

- Multiple `scroll` events fire at intermediate positions.
- Those intermediate positions may still read as "near bottom," keeping `shouldScrollToBottom = true`.
- The animation extends the time window during which the user's scroll input is overridden.

#### Summary

| Factor | Impact |
|--------|--------|
| `ngAfterViewChecked` | Fires every CD cycle (~dozens/sec during streaming), calling `scrollToBottom()` aggressively |
| 100 px threshold + race | User can't scroll past 100 px before the next `scrollToBottom()` snaps them back |
| `scroll-behavior: smooth` | Stretches the snap-back animation, widening the race window |

### Suggested Fix

Replace the `ngAfterViewChecked` lifecycle hook with an Angular `effect()` that reacts **only** to content changes. Use `requestAnimationFrame` to defer the scroll until after the DOM paints, and add a guard flag so programmatic scrolls don't re-trigger `onScroll` logic. Remove `scroll-behavior: smooth` from the container (or scope it only to user-initiated scrolls).

#### message-list.component.ts — proposed replacement

```typescript
import {
  Component, input, ElementRef, ViewChild,
  effect, OnDestroy
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { ScrollingModule } from '@angular/cdk/scrolling';
import { MatIconModule } from '@angular/material/icon';
import { marked } from 'marked';

import { MessageBubbleComponent } from '../message-bubble/message-bubble.component';
import type { ChatMessage, StreamingMessage } from '../../../../shared/types/message.types';

@Component({
  selector: 'app-message-list',
  standalone: true,
  imports: [
    CommonModule,
    ScrollingModule,
    MatIconModule,
    MessageBubbleComponent
  ],
  templateUrl: './message-list.component.html',
  styleUrl: './message-list.component.scss'
})
export class MessageListComponent implements OnDestroy {
  @ViewChild('scrollContainer') private scrollContainer!: ElementRef;

  // Inputs
  messages = input<ChatMessage[]>([]);
  streamingMessage = input<StreamingMessage | null>(null);
  latestThinking = input<string>('');
  agentName = input<string>('Agent');
  agentIcon = input<string | undefined>(undefined);

  /** Whether the user is near the bottom (and we should auto-scroll). */
  private isUserNearBottom = true;

  /** Guard flag: true while a programmatic scroll is in progress. */
  private isProgrammaticScroll = false;

  /** Pending requestAnimationFrame ID, for cleanup. */
  private pendingScrollRAF: number | null = null;

  constructor() {
    // Auto-scroll only when content-related signals change
    effect(() => {
      // Reading these signals registers them as dependencies
      this.messages();
      this.streamingMessage();
      this.latestThinking();

      if (this.isUserNearBottom) {
        this.scheduleScrollToBottom();
      }
    });
  }

  onScroll(event: Event): void {
    // Ignore scroll events caused by programmatic scrollTop changes
    if (this.isProgrammaticScroll) return;

    const el = event.target as HTMLElement;
    const atBottom = el.scrollHeight - el.scrollTop <= el.clientHeight + 100;
    this.isUserNearBottom = atBottom;
  }

  ngOnDestroy(): void {
    if (this.pendingScrollRAF !== null) {
      cancelAnimationFrame(this.pendingScrollRAF);
    }
  }

  trackByMessageId(_index: number, message: ChatMessage): string {
    return message.id;
  }

  /** Render thinking text with markdown support */
  renderThinking(text: string): string {
    return marked.parse(text, { async: false }) as string;
  }

  // ── Private ──────────────────────────────────────────────

  /**
   * Coalesce scroll requests into a single rAF so we scroll
   * only once per frame, after Angular has painted the DOM.
   */
  private scheduleScrollToBottom(): void {
    if (this.pendingScrollRAF !== null) {
      cancelAnimationFrame(this.pendingScrollRAF);
    }
    this.pendingScrollRAF = requestAnimationFrame(() => {
      this.pendingScrollRAF = null;
      this.scrollToBottom();
    });
  }

  private scrollToBottom(): void {
    if (!this.scrollContainer) return;
    const el = this.scrollContainer.nativeElement;

    this.isProgrammaticScroll = true;
    el.scrollTop = el.scrollHeight;

    // Reset the guard after the browser fires the resulting scroll event.
    requestAnimationFrame(() => {
      this.isProgrammaticScroll = false;
    });
  }
}
```

#### message-list.component.scss — remove `scroll-behavior: smooth`

```diff
 .message-list-container {
   flex: 1;
   overflow-y: auto;
   padding: 16px;
-  scroll-behavior: smooth;
   min-height: 0;
```

#### Why this fixes the problem

| Change | Effect |
|--------|--------|
| Replace `ngAfterViewChecked` with `effect()` | Scroll-to-bottom only runs when `messages`, `streamingMessage`, or `latestThinking` actually change — not on every CD cycle |
| `requestAnimationFrame` batching | Coalesces rapid signal updates into a single scroll per frame; ensures DOM has painted before scrolling |
| `isProgrammaticScroll` guard | Prevents programmatic `scrollTop` changes from re-triggering `onScroll` and resetting `isUserNearBottom` to `true` |
| Remove `scroll-behavior: smooth` | Eliminates the animated scroll that extends the race window and fires intermediate `scroll` events |

### Verification Steps

1. **Streaming scenario**: Start a long streaming response. While streaming, scroll up. Confirm the view stays where the user scrolled and does not snap back to the bottom.
2. **Resume auto-scroll**: After scrolling up during streaming, scroll back down to the bottom. Confirm auto-scroll resumes and new content is visible as it arrives.
3. **Idle scenario**: Send a message and wait for the full response. Scroll up through the conversation. Confirm scrolling is smooth and uninterrupted.
4. **New message arrives**: While scrolled up, have the agent finish a response (a new `ChatMessage` is added). Confirm the user's scroll position is preserved and they are not forced to the bottom.
5. **Initial load**: Open a conversation with existing history. Confirm the view starts scrolled to the bottom.
6. **Switch conversations**: Switch between conversations. Confirm each conversation starts at the bottom.
7. **Edge case — short chat**: Open a conversation that doesn't overflow the viewport. Confirm no erratic scrolling.
