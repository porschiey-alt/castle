/**
 * Conversation Service - Manages conversation state and operations
 */

import { Injectable, signal, computed, inject } from '@angular/core';
import { ElectronService } from './electron.service';
import { AgentService } from './agent.service';
import type { Conversation, CreateConversationInput, UpdateConversationInput } from '../../../shared/types/conversation.types';

@Injectable({
  providedIn: 'root'
})
export class ConversationService {
  private electronService = inject(ElectronService);
  private agentService = inject(AgentService);

  // State signals
  private conversationsSignal = signal<Map<string, Conversation[]>>(new Map());
  private activeConversationIdSignal = signal<string | null>(null);

  readonly activeConversationId = this.activeConversationIdSignal.asReadonly();

  readonly conversations = computed<Conversation[]>(() => {
    const agentId = this.agentService.selectedAgentId();
    if (!agentId) return [];
    return this.conversationsSignal().get(agentId) || [];
  });

  readonly activeConversation = computed<Conversation | null>(() => {
    const id = this.activeConversationIdSignal();
    if (!id) return null;
    return this.conversations().find(c => c.id === id) || null;
  });

  constructor() {
    // Listen for cross-device sync
    this.electronService.conversationsChanged$.subscribe(() => {
      const agentId = this.agentService.selectedAgentId();
      if (agentId) {
        this.loadConversations(agentId);
      }
    });
  }

  /**
   * Load conversations for an agent
   */
  async loadConversations(agentId: string): Promise<void> {
    const conversations = await this.electronService.getConversations(agentId);
    const map = new Map(this.conversationsSignal());
    map.set(agentId, conversations);
    this.conversationsSignal.set(map);
  }

  /**
   * Create a new conversation
   */
  async createConversation(agentId: string, title?: string): Promise<Conversation | null> {
    const conversation = await this.electronService.createConversation({
      agentId,
      title,
    });
    if (conversation) {
      await this.loadConversations(agentId);
      this.activeConversationIdSignal.set(conversation.id);
    }
    return conversation;
  }

  /**
   * Select a conversation
   */
  selectConversation(conversationId: string | null): void {
    this.activeConversationIdSignal.set(conversationId);
  }

  /**
   * Rename a conversation
   */
  async renameConversation(conversationId: string, title: string): Promise<void> {
    await this.electronService.updateConversation(conversationId, { title });
    const agentId = this.agentService.selectedAgentId();
    if (agentId) {
      await this.loadConversations(agentId);
    }
  }

  /**
   * Delete a conversation
   */
  async deleteConversation(conversationId: string): Promise<void> {
    const wasActive = this.activeConversationIdSignal() === conversationId;
    await this.electronService.deleteConversation(conversationId);
    
    const agentId = this.agentService.selectedAgentId();
    if (agentId) {
      await this.loadConversations(agentId);
    }

    if (wasActive) {
      // Select the most recent remaining conversation
      const remaining = this.conversations();
      this.activeConversationIdSignal.set(remaining.length > 0 ? remaining[0].id : null);
    }
  }

  /**
   * Auto-generate title from first message content
   */
  generateTitle(content: string): string {
    const cleaned = content.replace(/\n/g, ' ').trim();
    return cleaned.length > 50 ? cleaned.substring(0, 47) + '...' : cleaned;
  }

  /**
   * Select the most recent conversation for the current agent.
   * Call after loadConversations() to auto-select.
   */
  selectMostRecent(): void {
    const convs = this.conversations();
    this.activeConversationIdSignal.set(convs.length > 0 ? convs[0].id : null);
  }

  /**
   * Reset active conversation (e.g., when switching agents)
   */
  clearActive(): void {
    this.activeConversationIdSignal.set(null);
  }
}
