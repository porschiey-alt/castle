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
  /** Accumulated thinking text shown in the bubble, persists across non-thinking chunks */
  accumulatedThinking: string;
  /** Length of accumulated thinking as of last chunk – used to compute delta */
  previousThinkingLength: number;
  /** Length of content buffer as of last chunk – used to detect content updates */
  previousContentLength: number;
  /** Number of tool calls as of last chunk – used to detect tool-call updates */
  previousToolCallsCount: number;
}

function defaultChatState(): ChatState {
  return {
    messages: [],
    streamingMessage: null,
    streamingConversationId: null,
    isLoading: false,
    todoItems: [],
    accumulatedThinking: '',
    previousThinkingLength: 0,
    previousContentLength: 0,
    previousToolCallsCount: 0
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

  /** Accumulated thinking text, reset when a non-thinking chunk arrives */
  readonly accumulatedThinking = computed<string>(() => {
    const state = this.currentChatState();
    if (!state?.accumulatedThinking) return '';
    return this.isStreamingConversationActive() ? state.accumulatedThinking : '';
  });

  /** Per-agent lifecycle status (taskTitle + label) */
  private _lifecycleStatus = signal<Map<string, { taskId: string; label: string }>>(new Map());

  /** Lifecycle status banner text for the currently selected agent, or null */
  readonly lifecycleStatus = computed<string | null>(() => {
    const agentId = this.agentService.selectedAgentId();
    if (!agentId) return null;
    const entry = this._lifecycleStatus().get(agentId);
    return entry?.label ?? null;
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

    // Task research/implementation started streaming in a specific conversation
    this.electronService.streamingStarted$.subscribe(({ agentId, conversationId }) => {
      this.setStreamingConversationId(agentId, conversationId ?? null);
      this.setLoading(agentId, true);
    });

    // Worktree lifecycle status → update pinned banner per agent
    this.electronService.worktreeLifecycle$.subscribe((event) => {
      const label = this.lifecyclePhaseLabel(event.taskTitle, event.phase, event.message);
      if (event.phase === 'done') {
        this._lifecycleStatus.update(m => { const n = new Map(m); n.delete(event.agentId); return n; });
      } else if (label) {
        this._lifecycleStatus.update(m => {
          const n = new Map(m);
          n.set(event.agentId, { taskId: event.taskId, label });
          return n;
        });
      }
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

    const fullThinking = message.thinking || '';
    const contentLength = message.content?.length || 0;
    const toolCallsCount = message.toolCalls?.length || 0;

    // Check if new thinking text arrived
    const prevLen = currentState.previousThinkingLength;
    const hasNewThinking = fullThinking.length > prevLen;

    // Keep accumulated thinking visible even when non-thinking chunks arrive.
    // Only reset when a new thinking block starts after a non-thinking gap.
    let accumulatedThinking = currentState.accumulatedThinking;

    if (hasNewThinking) {
      const contentChanged = contentLength !== currentState.previousContentLength;
      const toolCallsChanged = toolCallsCount !== currentState.previousToolCallsCount;
      const hadNonThinkingGap = contentChanged || toolCallsChanged;

      if (hadNonThinkingGap) {
        // New thinking block after tool calls / content — start fresh
        accumulatedThinking = fullThinking.substring(prevLen);
      } else {
        accumulatedThinking += fullThinking.substring(prevLen);
      }
    }
    
    states.set(agentId, {
      ...currentState,
      streamingMessage: message,
      accumulatedThinking,
      previousThinkingLength: fullThinking.length,
      previousContentLength: contentLength,
      previousToolCallsCount: toolCallsCount
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
        accumulatedThinking: '',
        previousThinkingLength: 0,
        previousContentLength: 0,
        previousToolCallsCount: 0
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

  /** Map a worktree lifecycle phase to a human-readable status label */
  private lifecyclePhaseLabel(_taskTitle: string, phase: string, message?: string): string | null {
    switch (phase) {
      case 'creating_worktree': return 'Creating worktree…';
      case 'installing_deps':   return 'Installing dependencies…';
      case 'implementing':      return 'Agent is working…';
      case 'committing':        return 'Committing changes…';
      case 'creating_pr':       return 'Creating pull request…';
      case 'warning':           return message || 'Warning';
      default:                  return null;
    }
  }
}
