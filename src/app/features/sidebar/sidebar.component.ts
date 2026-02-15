/**
 * Sidebar Component - Agent circles list (Discord-like)
 */

import { Component, inject, output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatBadgeModule } from '@angular/material/badge';
import { MatDividerModule } from '@angular/material/divider';

import { AgentCircleComponent } from './agent-circle/agent-circle.component';
import { AgentService } from '../../core/services/agent.service';
import type { AgentWithSession } from '../../../shared/types/agent.types';

@Component({
  selector: 'app-sidebar',
  standalone: true,
  imports: [
    CommonModule,
    MatButtonModule,
    MatIconModule,
    MatTooltipModule,
    MatBadgeModule,
    MatDividerModule,
    AgentCircleComponent
  ],
  templateUrl: './sidebar.component.html',
  styleUrl: './sidebar.component.scss'
})
export class SidebarComponent {
  private agentService = inject(AgentService);

  // Output event for add agent button
  addAgentClicked = output<void>();

  // Expose signals to template
  agents = this.agentService.agentsWithSessions;
  selectedAgentId = this.agentService.selectedAgentId;
  loading = this.agentService.loading;

  selectAgent(agent: AgentWithSession): void {
    this.agentService.selectAgent(agent.id);
  }

  onAddAgent(): void {
    this.addAgentClicked.emit();
  }

  trackByAgentId(_index: number, agent: AgentWithSession): string {
    return agent.id;
  }
}
