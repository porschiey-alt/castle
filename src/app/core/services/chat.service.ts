/**
 * Chat Service - Manages chat messages and streaming
 */

import { Injectable, signal, computed, inject } from '@angular/core';
import { ElectronService } from './electron.service';
import { AgentService } from './agent.service';
import { ConversationService } from './conversation.service';
import type { ChatMessage, StreamingMessage, TodoItem } from '../../../shared/types/message.types';

interface ChatState {
  messages: ChatMessage[];
  streamingMessage: StreamingMessage | null;
  /** The conversation that owns the current streaming response */
  streamingConversationId: string | null;
  isLoading: boolean;
  todoItems: TodoItem[];
  /** Only the most recent thinking chunk (not accumulated) */
  latestThinking: string;
  /** Length of accumulated thinking as of last chunk – used to compute delta */
  previousThinkingLength: number;
}

function defaultChatState(): ChatState {
  return {
    messages: [],
    streamingMessage: null,
    streamingConversationId: null,
    isLoading: false,
    todoItems: [],
    latestThinking: '',
    previousThinkingLength: 0
  };
}

@Injectable({
  providedIn: 'root'
})
export class ChatService {
  // State per agent
  private chatStatesSignal = signal<Map<string, ChatState>>(new Map());
  
  private electronService = inject(ElectronService);
  private agentService = inject(AgentService);
  private conversationService = inject(ConversationService);
  
  // Current agent's chat state
  readonly currentChatState = computed<ChatState | null>(() => {
    const selectedAgentId = this.agentService.selectedAgentId();
    if (!selectedAgentId) return null;
    
    return this.chatStatesSignal().get(selectedAgentId) || defaultChatState();
  });

  /** True when the active conversation is the one being streamed */
  private readonly isStreamingConversationActive = computed<boolean>(() => {
    const state = this.currentChatState();
    if (!state?.streamingConversationId) return false;
    return this.conversationService.activeConversationId() === state.streamingConversationId;
  });

  readonly messages = computed<ChatMessage[]>(() => {
    return this.currentChatState()?.messages || [];
  });

  readonly streamingMessage = computed<StreamingMessage | null>(() => {
    const state = this.currentChatState();
    if (!state?.streamingMessage) return null;
    return this.isStreamingConversationActive() ? state.streamingMessage : null;
  });

  readonly isLoading = computed<boolean>(() => {
    const state = this.currentChatState();
    if (!state?.isLoading) return false;
    return this.isStreamingConversationActive();
  });

  readonly todoItems = computed<TodoItem[]>(() => {
    const state = this.currentChatState();
    if (!state?.todoItems?.length) return [];
    return this.isStreamingConversationActive() ? state.todoItems : [];
  });

  /** Only the most recent thinking chunk from the streaming agent */
  readonly latestThinking = computed<string>(() => {
    const state = this.currentChatState();
    if (!state?.latestThinking) return '';
    return this.isStreamingConversationActive() ? state.latestThinking : '';
  });

  constructor() {
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
      // Capture streaming segments before clearing so they persist in the saved message
      const currentState = this.chatStatesSignal().get(message.agentId);
      const segments = currentState?.streamingMessage?.segments;
      if (segments && segments.length > 0) {
        message.metadata = { ...message.metadata, segments };
      }

      // Only add the message to in-memory state if the user is still
      // viewing the conversation that was being streamed. Otherwise the
      // message is already persisted in the DB and will appear when the
      // user navigates back to that conversation.
      const activeConvId = this.conversationService.activeConversationId();
      const streamConvId = currentState?.streamingConversationId ?? message.conversationId;
      if (activeConvId && activeConvId === streamConvId) {
        this.addMessageIfNew(message.agentId, message);
      }

      this.clearStreamingMessage(message.agentId);
      this.setLoading(message.agentId, false);
      
      // Update agent session status to ready
      this.agentService.updateSessionStatus(message.agentId, 'ready');
      
      // Increment unread count if not the selected agent
      this.agentService.incrementUnreadCount(message.agentId);
    });

    // Cross-device sync: a message was added from another device — reload full history
    this.electronService.chatMessageAdded$.subscribe((message: ChatMessage) => {
      this.loadHistory(message.agentId);
    });
  }

  /**
   * Load chat history for an agent, scoped to the active conversation
   */
  async loadHistory(agentId: string): Promise<void> {
    const conversationId = this.conversationService.activeConversationId();
    
    let messages: ChatMessage[];
    if (conversationId) {
      messages = await this.electronService.getConversationMessages(conversationId);
    } else {
      // No conversation selected — show empty state (ready for new chat)
      messages = [];
    }
    
    const states = new Map(this.chatStatesSignal());
    const currentState = states.get(agentId) || defaultChatState();
    
    states.set(agentId, {
      ...currentState,
      messages
    });
    
    this.chatStatesSignal.set(states);
  }

  /**
   * Send a message to an agent, creating a conversation if needed
   */
  async sendMessage(agentId: string, content: string): Promise<void> {
    this.setLoading(agentId, true);

    try {
      // Auto-create conversation on first message if none exists
      let conversationId = this.conversationService.activeConversationId();
      if (!conversationId) {
        const title = this.conversationService.generateTitle(content);
        const conversation = await this.conversationService.createConversation(agentId, title);
        conversationId = conversation?.id || null;
      }

      // Track which conversation this stream belongs to
      this.setStreamingConversationId(agentId, conversationId);

      const userMessage = await this.electronService.sendMessage(agentId, content, conversationId || undefined);
      if (userMessage) {
        this.addMessageIfNew(agentId, userMessage);
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
    const currentState = states.get(agentId) || defaultChatState();
    
    states.set(agentId, {
      ...currentState,
      messages: [...currentState.messages, message]
    });
    
    this.chatStatesSignal.set(states);
  }

  /** Add a message only if it isn't already in the list (for cross-device sync) */
  private addMessageIfNew(agentId: string, message: ChatMessage): void {
    const states = this.chatStatesSignal();
    const currentState = states.get(agentId);
    if (currentState?.messages.some(m => m.id === message.id)) return;
    this.addMessage(agentId, message);
  }

  /**
   * Update streaming message for an agent
   */
  private updateStreamingMessage(agentId: string, message: StreamingMessage): void {
    const states = new Map(this.chatStatesSignal());
    const currentState = states.get(agentId) || defaultChatState();

    // Compute latest thinking chunk (delta since last update)
    const prevLen = currentState.previousThinkingLength;
    const fullThinking = message.thinking || '';
    const latestThinking = fullThinking.length > prevLen
      ? fullThinking.substring(prevLen).trim()
      : currentState.latestThinking;
    
    states.set(agentId, {
      ...currentState,
      streamingMessage: message,
      latestThinking: latestThinking || currentState.latestThinking,
      previousThinkingLength: fullThinking.length
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
        streamingMessage: null,
        streamingConversationId: null,
        latestThinking: '',
        previousThinkingLength: 0
      });
      this.chatStatesSignal.set(states);
    }
  }

  /**
   * Update todo items for an agent
   */
  private updateTodoItems(agentId: string, todoItems: TodoItem[]): void {
    const states = new Map(this.chatStatesSignal());
    const currentState = states.get(agentId) || defaultChatState();
    
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
    const currentState = states.get(agentId) || defaultChatState();
    
    states.set(agentId, {
      ...currentState,
      isLoading
    });
    
    this.chatStatesSignal.set(states);
  }

  /**
   * Record which conversation the current stream belongs to
   */
  private setStreamingConversationId(agentId: string, conversationId: string | null): void {
    const states = new Map(this.chatStatesSignal());
    const currentState = states.get(agentId) || defaultChatState();
    
    states.set(agentId, {
      ...currentState,
      streamingConversationId: conversationId
    });
    
    this.chatStatesSignal.set(states);
  }
}
