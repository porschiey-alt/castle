/**
 * Message type definitions shared between main and renderer processes
 */

export interface ChatMessage {
  id: string;
  agentId: string;
  role: MessageRole;
  content: string;
  timestamp: Date;
  metadata?: MessageMetadata;
}

export type MessageRole = 'user' | 'assistant' | 'system';

export interface MessageMetadata {
  toolCalls?: ToolCall[];
  model?: string;
  tokens?: {
    input: number;
    output: number;
  };
  duration?: number;
  error?: string;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  status: ToolCallStatus;
  result?: string;
  error?: string;
}

export type ToolCallStatus = 'pending' | 'running' | 'success' | 'error';

export interface StreamingMessage {
  id: string;
  agentId: string;
  content: string;
  thinking: string;
  isComplete: boolean;
  toolCalls?: ToolCall[];
}

export interface AgentBusMessage {
  id: string;
  fromAgentId: string;
  toAgentId: string | 'broadcast';
  content: string;
  timestamp: Date;
  type: 'request' | 'response' | 'notification';
}
