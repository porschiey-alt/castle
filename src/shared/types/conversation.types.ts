/**
 * Conversation type definitions shared between main and renderer processes
 */

export interface Conversation {
  id: string;
  agentId: string;
  acpSessionId?: string;
  title?: string;
  workingDirectory?: string;
  createdAt: Date;
  updatedAt: Date;
  messageCount?: number;
  lastMessage?: string;
}

export interface CreateConversationInput {
  agentId: string;
  title?: string;
  workingDirectory?: string;
}

export interface UpdateConversationInput {
  title?: string;
  acpSessionId?: string;
}
