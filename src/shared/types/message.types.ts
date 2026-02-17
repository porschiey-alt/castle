/**
 * Message type definitions shared between main and renderer processes
 */

export interface ChatMessage {
  id: string;
  agentId: string;
  conversationId?: string;
  role: MessageRole;
  content: string;
  timestamp: Date;
  metadata?: MessageMetadata;
}

export type MessageRole = 'user' | 'assistant' | 'system';

export interface MessageMetadata {
  toolCalls?: ToolCall[];
  /** Preserved segment history so tool calls and intermediate text survive after streaming ends */
  segments?: MessageSegment[];
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

/** A chronologically-ordered segment of an assistant turn */
export type MessageSegment =
  | { type: 'text'; content: string }
  | { type: 'tool-calls'; toolCalls: ToolCall[] };

export interface TodoItem {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  priority?: 'high' | 'medium' | 'low';
}

export interface StreamingMessage {
  id: string;
  agentId: string;
  content: string;
  thinking: string;
  isComplete: boolean;
  toolCalls?: ToolCall[];
  todoItems?: TodoItem[];
  /** Chronologically-ordered segments of text and tool-call groups */
  segments?: MessageSegment[];
}

export interface AgentBusMessage {
  id: string;
  fromAgentId: string;
  toAgentId: string | 'broadcast';
  content: string;
  timestamp: Date;
  type: 'request' | 'response' | 'notification';
}
