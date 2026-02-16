/**
 * Chat Service - Manages chat messages and streaming
 */

import { Injectable, signal, computed } from '@angular/core';
import { ElectronService } from './electron.service';
import { AgentService } from './agent.service';
import type { ChatMessage, StreamingMessage, TodoItem } from '../../../shared/types/message.types';

interface ChatState {
  messages: ChatMessage[];
  streamingMessage: StreamingMessage | null;
  isLoading: boolean;
  todoItems: TodoItem[];
}

@Injectable({
  providedIn: 'root'
})
export class ChatService {
  // State per agent
  private chatStatesSignal = signal<Map<string, ChatState>>(new Map());
  
  // Current agent's chat state
  readonly currentChatState = computed<ChatState | null>(() => {
    const selectedAgentId = this.agentService.selectedAgentId();
    if (!selectedAgentId) return null;
    
    return this.chatStatesSignal().get(selectedAgentId) || {
      messages: [],
      streamingMessage: null,
      isLoading: false,
      todoItems: []
    };
  });

  readonly messages = computed<ChatMessage[]>(() => {
    return this.currentChatState()?.messages || [];
  });

  readonly streamingMessage = computed<StreamingMessage | null>(() => {
    return this.currentChatState()?.streamingMessage || null;
  });

  readonly isLoading = computed<boolean>(() => {
    return this.currentChatState()?.isLoading || false;
  });

  readonly todoItems = computed<TodoItem[]>(() => {
    return this.currentChatState()?.todoItems || [];
  });

  constructor(
    private electronService: ElectronService,
    private agentService: AgentService
  ) {
    this.setupStreamingListeners();
  }

  private setupStreamingListeners(): void {
    // Listen for streaming chunks
    this.electronService.streamChunk$.subscribe((chunk: StreamingMessage) => {
      this.updateStreamingMessage(chunk.agentId, chunk);
      
      // Update todo items if present
      if (chunk.todoItems && chunk.todoItems.length > 0) {
        this.updateTodoItems(chunk.agentId, chunk.todoItems);
      }
      
      // Ensure loading state is true so the stop button is visible
      this.setLoading(chunk.agentId, true);

      // Update agent session status to busy
      this.agentService.updateSessionStatus(chunk.agentId, 'busy');
    });

    // Listen for stream completion
    this.electronService.streamComplete$.subscribe((message: ChatMessage) => {
      this.addMessage(message.agentId, message);
      this.clearStreamingMessage(message.agentId);
      this.setLoading(message.agentId, false);
      
      // Update agent session status to ready
      this.agentService.updateSessionStatus(message.agentId, 'ready');
      
      // Increment unread count if not the selected agent
      this.agentService.incrementUnreadCount(message.agentId);
    });
  }

  /**
   * Load chat history for an agent
   */
  async loadHistory(agentId: string): Promise<void> {
    const messages = await this.electronService.getChatHistory(agentId);
    
    const states = new Map(this.chatStatesSignal());
    const currentState = states.get(agentId) || {
      messages: [],
      streamingMessage: null,
      isLoading: false,
      todoItems: []
    };
    
    states.set(agentId, {
      ...currentState,
      messages
    });
    
    this.chatStatesSignal.set(states);
  }

  /**
   * Send a message to an agent
   */
  async sendMessage(agentId: string, content: string): Promise<void> {
    this.setLoading(agentId, true);

    try {
      const userMessage = await this.electronService.sendMessage(agentId, content);
      if (userMessage) {
        this.addMessage(agentId, userMessage);
      }
    } catch (error) {
      this.setLoading(agentId, false);
      throw error;
    }
  }

  /**
   * Cancel the in-progress message for an agent
   */
  async cancelMessage(agentId: string): Promise<void> {
    await this.electronService.cancelMessage(agentId);
    this.clearStreamingMessage(agentId);
    this.setLoading(agentId, false);
    this.agentService.updateSessionStatus(agentId, 'stopped');
  }

  /**
   * Clear chat history for an agent
   */
  async clearHistory(agentId: string): Promise<void> {
    await this.electronService.clearChatHistory(agentId);
    
    const states = new Map(this.chatStatesSignal());
    const currentState = states.get(agentId);
    
    if (currentState) {
      states.set(agentId, {
        ...currentState,
        messages: [],
        todoItems: []
      });
      this.chatStatesSignal.set(states);
    }
  }

  /**
   * Add a message to an agent's chat
   */
  private addMessage(agentId: string, message: ChatMessage): void {
    const states = new Map(this.chatStatesSignal());
    const currentState = states.get(agentId) || {
      messages: [],
      streamingMessage: null,
      isLoading: false,
      todoItems: []
    };
    
    states.set(agentId, {
      ...currentState,
      messages: [...currentState.messages, message]
    });
    
    this.chatStatesSignal.set(states);
  }

  /**
   * Update streaming message for an agent
   */
  private updateStreamingMessage(agentId: string, message: StreamingMessage): void {
    const states = new Map(this.chatStatesSignal());
    const currentState = states.get(agentId) || {
      messages: [],
      streamingMessage: null,
      isLoading: true,
      todoItems: []
    };
    
    states.set(agentId, {
      ...currentState,
      streamingMessage: message
    });
    
    this.chatStatesSignal.set(states);
  }

  /**
   * Clear streaming message for an agent
   */
  private clearStreamingMessage(agentId: string): void {
    const states = new Map(this.chatStatesSignal());
    const currentState = states.get(agentId);
    
    if (currentState) {
      states.set(agentId, {
        ...currentState,
        streamingMessage: null
      });
      this.chatStatesSignal.set(states);
    }
  }

  /**
   * Update todo items for an agent
   */
  private updateTodoItems(agentId: string, todoItems: TodoItem[]): void {
    const states = new Map(this.chatStatesSignal());
    const currentState = states.get(agentId) || {
      messages: [],
      streamingMessage: null,
      isLoading: false,
      todoItems: []
    };
    
    states.set(agentId, {
      ...currentState,
      todoItems
    });
    
    this.chatStatesSignal.set(states);
  }

  /**
   * Set loading state for an agent
   */
  private setLoading(agentId: string, isLoading: boolean): void {
    const states = new Map(this.chatStatesSignal());
    const currentState = states.get(agentId) || {
      messages: [],
      streamingMessage: null,
      isLoading: false,
      todoItems: []
    };
    
    states.set(agentId, {
      ...currentState,
      isLoading
    });
    
    this.chatStatesSignal.set(states);
  }
}
