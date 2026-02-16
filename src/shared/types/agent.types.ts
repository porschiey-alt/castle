/**
 * Agent type definitions shared between main and renderer processes
 */

export interface Agent {
  id: string;
  name: string;
  description: string;
  icon?: string;           // Emoji or icon identifier
  color?: string;          // Hex color for the agent circle
  systemPrompt?: string;   // Custom instructions for this agent
  source: 'builtin' | 'workspace';
  capabilities?: string[];
  mcpServers?: MCPServerConfig[];
}

export interface CastleAgentConfig {
  name: string;
  icon?: string;
  color?: string;
  description?: string;
  systemPrompt?: string;
}

export interface MCPServerConfig {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface AgentDiscoveryResult {
  builtinAgents: Agent[];
  workspaceAgents: Agent[];
  combined: Agent[];
}

export interface AgentSession {
  id: string;
  agentId: string;
  workingDirectory: string;
  status: AgentSessionStatus;
  startedAt: Date;
  lastActivityAt: Date;
}

export type AgentSessionStatus = 
  | 'starting' 
  | 'ready' 
  | 'busy' 
  | 'error' 
  | 'stopped';

export interface AgentWithSession extends Agent {
  session?: AgentSession;
  unreadCount: number;
}
