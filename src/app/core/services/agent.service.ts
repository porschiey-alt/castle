/**
 * Agent Service - Manages agent state and operations
 */

import { Injectable, signal, computed } from '@angular/core';
import { ElectronService } from './electron.service';
import type { Agent, AgentWithSession, AgentSession } from '../../../shared/types/agent.types';

@Injectable({
  providedIn: 'root'
})
export class AgentService {
  // State signals
  private agentsSignal = signal<Agent[]>([]);
  private sessionsSignal = signal<Map<string, AgentSession>>(new Map());
  private selectedAgentIdSignal = signal<string | null>(null);
  private unreadCountsSignal = signal<Map<string, number>>(new Map());
  private loadingSignal = signal<boolean>(false);
  private sessionInitializingSignal = signal<Set<string>>(new Set());
  private workspacePath: string | null = null;

  // Computed values
  readonly agents = this.agentsSignal.asReadonly();
  readonly selectedAgentId = this.selectedAgentIdSignal.asReadonly();
  readonly loading = this.loadingSignal.asReadonly();
  readonly sessionInitializing = this.sessionInitializingSignal.asReadonly();

  /**
   * Check if a specific agent's session is currently initializing
   */
  isSessionInitializing(agentId: string): boolean {
    return this.sessionInitializingSignal().has(agentId);
  }

  readonly agentsWithSessions = computed<AgentWithSession[]>(() => {
    const agents = this.agentsSignal();
    const sessions = this.sessionsSignal();
    const unreadCounts = this.unreadCountsSignal();

    return agents.map(agent => ({
      ...agent,
      session: sessions.get(agent.id),
      unreadCount: unreadCounts.get(agent.id) || 0
    }));
  });

  readonly selectedAgent = computed<AgentWithSession | null>(() => {
    const selectedId = this.selectedAgentIdSignal();
    if (!selectedId) return null;
    
    return this.agentsWithSessions().find(a => a.id === selectedId) || null;
  });

  constructor(private electronService: ElectronService) {}

  /**
   * Discover and load agents for a workspace
   */
  async discoverAgents(workspacePath: string): Promise<void> {
    this.loadingSignal.set(true);
    this.workspacePath = workspacePath;
    
    try {
      const result = await this.electronService.discoverAgents(workspacePath);
      if (result) {
        this.agentsSignal.set(result.combined);
        
        // Select first agent by default (this will auto-start its session)
        if (result.combined.length > 0 && !this.selectedAgentIdSignal()) {
          await this.selectAgent(result.combined[0].id);
        }
      }
    } finally {
      this.loadingSignal.set(false);
    }
  }

  /**
   * Select an agent and auto-start its session
   */
  async selectAgent(agentId: string): Promise<void> {
    this.selectedAgentIdSignal.set(agentId);
    
    // Clear unread count for selected agent
    const unreadCounts = new Map(this.unreadCountsSignal());
    unreadCounts.set(agentId, 0);
    this.unreadCountsSignal.set(unreadCounts);

    // Auto-start session if not already active
    if (this.workspacePath && !this.hasActiveSession(agentId)) {
      const inits = new Set(this.sessionInitializingSignal());
      inits.add(agentId);
      this.sessionInitializingSignal.set(inits);
      try {
        await this.startSession(agentId, this.workspacePath);
      } catch (e) {
        console.error(`Failed to auto-start session for agent ${agentId}:`, e);
      } finally {
        const done = new Set(this.sessionInitializingSignal());
        done.delete(agentId);
        this.sessionInitializingSignal.set(done);
      }
    }
  }

  /**
   * Start a session for an agent
   */
  async startSession(agentId: string, workingDirectory: string): Promise<AgentSession | null> {
    const session = await this.electronService.startAgentSession(agentId, workingDirectory);
    
    if (session) {
      const sessions = new Map(this.sessionsSignal());
      sessions.set(agentId, session);
      this.sessionsSignal.set(sessions);
    }
    
    return session;
  }

  /**
   * Stop a session for an agent
   */
  async stopSession(agentId: string): Promise<void> {
    const sessions = this.sessionsSignal();
    const session = sessions.get(agentId);
    
    if (session) {
      await this.electronService.stopAgentSession(session.id);
      
      const newSessions = new Map(sessions);
      newSessions.delete(agentId);
      this.sessionsSignal.set(newSessions);
    }
  }

  /**
   * Update session status
   */
  updateSessionStatus(agentId: string, status: AgentSession['status']): void {
    const sessions = new Map(this.sessionsSignal());
    const session = sessions.get(agentId);
    
    if (session) {
      sessions.set(agentId, { ...session, status, lastActivityAt: new Date() });
      this.sessionsSignal.set(sessions);
    }
  }

  /**
   * Increment unread count for an agent
   */
  incrementUnreadCount(agentId: string): void {
    // Don't increment if this is the selected agent
    if (agentId === this.selectedAgentIdSignal()) return;
    
    const unreadCounts = new Map(this.unreadCountsSignal());
    const current = unreadCounts.get(agentId) || 0;
    unreadCounts.set(agentId, current + 1);
    this.unreadCountsSignal.set(unreadCounts);
  }

  /**
   * Get agent by ID
   */
  getAgent(agentId: string): Agent | undefined {
    return this.agentsSignal().find(a => a.id === agentId);
  }

  /**
   * Check if agent has active session
   */
  hasActiveSession(agentId: string): boolean {
    const session = this.sessionsSignal().get(agentId);
    return session !== undefined && session.status !== 'stopped' && session.status !== 'error';
  }
}
