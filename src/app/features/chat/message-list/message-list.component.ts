/**
 * Message List Component - Displays chat messages
 */

import { Component, input, ElementRef, ViewChild, AfterViewChecked } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ScrollingModule } from '@angular/cdk/scrolling';

import { MessageBubbleComponent } from '../message-bubble/message-bubble.component';
import type { ChatMessage, StreamingMessage } from '../../../../shared/types/message.types';

@Component({
  selector: 'app-message-list',
  standalone: true,
  imports: [
    CommonModule,
    ScrollingModule,
    MessageBubbleComponent
  ],
  templateUrl: './message-list.component.html',
  styleUrl: './message-list.component.scss'
})
export class MessageListComponent implements AfterViewChecked {
  @ViewChild('scrollContainer') private scrollContainer!: ElementRef;

  // Inputs
  messages = input<ChatMessage[]>([]);
  streamingMessage = input<StreamingMessage | null>(null);
  agentName = input<string>('Agent');
  agentIcon = input<string | undefined>(undefined);

  private shouldScrollToBottom = true;

  ngAfterViewChecked(): void {
    if (this.shouldScrollToBottom) {
      this.scrollToBottom();
    }
  }

  onScroll(event: Event): void {
    const element = event.target as HTMLElement;
    const atBottom = element.scrollHeight - element.scrollTop <= element.clientHeight + 100;
    this.shouldScrollToBottom = atBottom;
  }

  private scrollToBottom(): void {
    if (this.scrollContainer) {
      const element = this.scrollContainer.nativeElement;
      element.scrollTop = element.scrollHeight;
    }
  }

  trackByMessageId(_index: number, message: ChatMessage): string {
    return message.id;
  }
}
