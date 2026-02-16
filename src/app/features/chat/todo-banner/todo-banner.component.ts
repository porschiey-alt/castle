/**
 * Todo Banner Component - Displays agent's todo/plan items pinned to top of chat
 */

import { Component, input, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import type { TodoItem } from '../../../../shared/types/message.types';

@Component({
  selector: 'app-todo-banner',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './todo-banner.component.html',
  styleUrl: './todo-banner.component.scss'
})
export class TodoBannerComponent {
  items = input.required<TodoItem[]>();
  collapsed = signal(false);

  toggleCollapsed(): void {
    this.collapsed.set(!this.collapsed());
  }

  completedCount(): number {
    return this.items().filter(i => i.status === 'completed').length;
  }

  totalCount(): number {
    return this.items().length;
  }

  statusIcon(status: TodoItem['status']): string {
    switch (status) {
      case 'completed': return '✓';
      case 'in_progress': return '◉';
      default: return '○';
    }
  }
}
