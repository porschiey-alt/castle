/**
 * Chat Component - Main chat interface
 */

import { Component, input, inject, OnInit, OnChanges, SimpleChanges, effect } from '@angular/core';
import { CommonModule } from '@angular/common';

import { MessageListComponent } from './message-list/message-list.component';
import { ChatInputComponent } from './chat-input/chat-input.component';
import { TodoBannerComponent } from './todo-banner/todo-banner.component';

import { ChatService } from '../../core/services/chat.service';
import { AgentService } from '../../core/services/agent.service';
import { ConversationService } from '../../core/services/conversation.service';
import type { AgentWithSession } from '../../../shared/types/agent.types';

@Component({
  selector: 'app-chat',
  standalone: true,
  imports: [
    CommonModule,
    MessageListComponent,
    ChatInputComponent,
    TodoBannerComponent
  ],
  templateUrl: './chat.component.html',
  styleUrl: './chat.component.scss'
})
export class ChatComponent implements OnInit, OnChanges {
  private chatService = inject(ChatService);
  private agentService = inject(AgentService);
  private conversationService = inject(ConversationService);

  // Input
  agent = input.required<AgentWithSession>();

  // Expose signals
  messages = this.chatService.messages;
  streamingMessage = this.chatService.streamingMessage;
  isLoading = this.chatService.isLoading;
  todoItems = this.chatService.todoItems;

  constructor() {
    // Reload history when active conversation changes
    effect(() => {
      const convId = this.conversationService.activeConversationId();
      // Side effect: reload messages for the new conversation
      const agentId = this.agentService.selectedAgentId();
      if (agentId) {
        this.chatService.loadHistory(agentId);
      }
    });
  }

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
    }
  }

  async onStopProcessing(): Promise<void> {
    const agentId = this.agent().id;
    try {
      await this.chatService.cancelMessage(agentId);
    } catch (error) {
      console.error('Failed to cancel message:', error);
    }
  }
}
