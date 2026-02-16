/**
 * Chat Component - Main chat interface
 */

import { Component, input, inject, OnInit, OnChanges, SimpleChanges } from '@angular/core';
import { CommonModule } from '@angular/common';

import { MessageListComponent } from './message-list/message-list.component';
import { ChatInputComponent } from './chat-input/chat-input.component';

import { ChatService } from '../../core/services/chat.service';
import { AgentService } from '../../core/services/agent.service';
import type { AgentWithSession } from '../../../shared/types/agent.types';

@Component({
  selector: 'app-chat',
  standalone: true,
  imports: [
    CommonModule,
    MessageListComponent,
    ChatInputComponent
  ],
  templateUrl: './chat.component.html',
  styleUrl: './chat.component.scss'
})
export class ChatComponent implements OnInit, OnChanges {
  private chatService = inject(ChatService);
  private agentService = inject(AgentService);

  // Input
  agent = input.required<AgentWithSession>();

  // Expose signals
  messages = this.chatService.messages;
  streamingMessage = this.chatService.streamingMessage;
  isLoading = this.chatService.isLoading;

  isInitializing(): boolean {
    return this.agentService.isSessionInitializing(this.agent().id);
  }

  ngOnInit(): void {
    this.loadHistory();
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['agent'] && !changes['agent'].firstChange) {
      this.loadHistory();
    }
  }

  private async loadHistory(): Promise<void> {
    const agentId = this.agent().id;
    await this.chatService.loadHistory(agentId);
  }

  async onSendMessage(content: string): Promise<void> {
    const agentId = this.agent().id;
    try {
      await this.chatService.sendMessage(agentId, content);
    } catch (error) {
      console.error('Failed to send message:', error);
      // TODO: Show error notification
    }
  }
}
