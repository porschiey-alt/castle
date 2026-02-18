/**
 * Conversation List Component - Shows list of conversations for an agent
 */

import { Component, inject, output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatMenuModule } from '@angular/material/menu';
import { MatDividerModule } from '@angular/material/divider';

import { MatDialog } from '@angular/material/dialog';

import { ConversationService } from '../../../core/services/conversation.service';
import { AgentService } from '../../../core/services/agent.service';
import { ConfirmDialogComponent } from '../../../shared/components/confirm-dialog/confirm-dialog.component';
import type { Conversation } from '../../../../shared/types/conversation.types';

@Component({
  selector: 'app-conversation-list',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    MatIconModule,
    MatButtonModule,
    MatTooltipModule,
    MatMenuModule,
    MatDividerModule
  ],
  templateUrl: './conversation-list.component.html',
  styleUrl: './conversation-list.component.scss'
})
export class ConversationListComponent {
  private conversationService = inject(ConversationService);
  private agentService = inject(AgentService);
  private dialog = inject(MatDialog);

  conversationSelected = output<string>();

  conversations = this.conversationService.conversations;
  activeConversationId = this.conversationService.activeConversationId;

  // Inline rename state
  renamingId: string | null = null;
  renameValue = '';

  async newChat(): Promise<void> {
    const agentId = this.agentService.selectedAgentId();
    if (!agentId) return;
    this.conversationService.selectConversation(null);
    this.conversationSelected.emit('');
  }

  selectConversation(conversation: Conversation): void {
    this.conversationService.selectConversation(conversation.id);
    this.conversationSelected.emit(conversation.id);
  }

  startRename(conversation: Conversation, event: Event): void {
    event.stopPropagation();
    this.renamingId = conversation.id;
    this.renameValue = conversation.title || '';
  }

  async commitRename(): Promise<void> {
    if (this.renamingId && this.renameValue.trim()) {
      await this.conversationService.renameConversation(this.renamingId, this.renameValue.trim());
    }
    this.renamingId = null;
    this.renameValue = '';
  }

  cancelRename(): void {
    this.renamingId = null;
    this.renameValue = '';
  }

  async deleteConversation(conversation: Conversation, event: Event): Promise<void> {
    event.stopPropagation();
    await this.conversationService.deleteConversation(conversation.id);
  }

  async clearAllConversations(): Promise<void> {
    const dialogRef = this.dialog.open(ConfirmDialogComponent, {
      data: {
        title: 'Delete All Conversations',
        message: 'Are you sure you want to delete all conversations? This action cannot be undone.',
        confirmText: 'Delete All',
        cancelText: 'Cancel'
      }
    });

    dialogRef.afterClosed().subscribe(async (confirmed: boolean) => {
      if (confirmed) {
        await this.conversationService.deleteAllConversations();
      }
    });
  }

  formatTime(date: Date | string): string {
    const d = new Date(date);
    const now = new Date();
    const diffMs = now.getTime() - d.getTime();
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

    if (diffDays < 0) {
      return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } else if (diffDays === 0) {
      return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } else if (diffDays === 1) {
      return 'Yesterday';
    } else if (diffDays < 7) {
      return `${diffDays} days ago`;
    } else {
      return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
    }
  }

  trackById(_index: number, conv: Conversation): string {
    return conv.id;
  }
}
