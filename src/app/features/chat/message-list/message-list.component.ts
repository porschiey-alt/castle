/**
 * Message List Component - Displays chat messages
 */

import { Component, input, ElementRef, ViewChild, AfterViewInit, effect } from '@angular/core';
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
export class MessageListComponent implements AfterViewInit {
  @ViewChild('scrollContainer') private scrollContainer!: ElementRef;

  // Inputs
  messages = input<ChatMessage[]>([]);
  streamingMessage = input<StreamingMessage | null>(null);
  latestThinking = input<string>('');
  agentName = input<string>('Agent');
  agentIcon = input<string | undefined>(undefined);

  private userHasScrolledUp = false;
  private isAutoScrolling = false;
  private viewReady = false;

  constructor() {
    // React to content changes only — not every CD cycle
    effect(() => {
      this.messages();
      this.streamingMessage();
      if (this.viewReady && !this.userHasScrolledUp) {
        Promise.resolve().then(() => this.scrollToBottom());
      }
    });
  }

  ngAfterViewInit(): void {
    this.viewReady = true;
    this.scrollToBottom();
  }

  onScroll(): void {
    if (this.isAutoScrolling) {
      return;
    }
    const el = this.scrollContainer.nativeElement;
    const atBottom = el.scrollHeight - el.scrollTop <= el.clientHeight + 50;
    this.userHasScrolledUp = !atBottom;
  }

  private scrollToBottom(): void {
    if (!this.scrollContainer) return;
    const el = this.scrollContainer.nativeElement;
    this.isAutoScrolling = true;
    el.scrollTop = el.scrollHeight;
    requestAnimationFrame(() => {
      this.isAutoScrolling = false;
    });
  }

  trackByMessageId(_index: number, message: ChatMessage): string {
    return message.id;
  }

  /** Render thinking text with markdown support */
  renderThinking(text: string): string {
    return marked.parse(text, { async: false }) as string;
  }
}
