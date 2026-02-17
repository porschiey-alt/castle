/**
 * Agent Circle Component - Individual agent button in sidebar
 */

import { Component, input, output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatBadgeModule } from '@angular/material/badge';

import { AgentIconComponent } from '../../../shared/components/agent-icon/agent-icon.component';
import type { AgentWithSession } from '../../../../shared/types/agent.types';

@Component({
  selector: 'app-agent-circle',
  standalone: true,
  imports: [
    CommonModule,
    MatButtonModule,
    MatIconModule,
    MatTooltipModule,
    MatBadgeModule,
    AgentIconComponent
  ],
  templateUrl: './agent-circle.component.html',
  styleUrl: './agent-circle.component.scss'
})
export class AgentCircleComponent {
  // Inputs
  agent = input.required<AgentWithSession>();
  isSelected = input<boolean>(false);

  // Outputs
  selected = output<AgentWithSession>();
  editRequested = output<AgentWithSession>();

  onSelect(): void {
    this.selected.emit(this.agent());
  }

  onContextMenu(event: MouseEvent): void {
    event.preventDefault();
    this.editRequested.emit(this.agent());
  }

  getStatusClass(): string {
    const session = this.agent().session;
    if (!session) return '';
    return `status-${session.status}`;
  }

  hasUnread(): boolean {
    return this.agent().unreadCount > 0;
  }
}
