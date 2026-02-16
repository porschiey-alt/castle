import { Component, input, output, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';

import { parseMarkdownSections, type MarkdownSection } from '../../../shared/utils/markdown-sections';
import type { ResearchComment, ResearchCommentAnchor } from '../../../../shared/types/task.types';

@Component({
  selector: 'app-research-content',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    MatIconModule,
    MatButtonModule,
    MatTooltipModule,
    MatFormFieldModule,
    MatInputModule,
  ],
  templateUrl: './research-content.component.html',
  styleUrl: './research-content.component.scss'
})
export class ResearchContentComponent {
  content = input.required<string>();
  pendingComments = input<ResearchComment[]>([]);

  commentAdded = output<{ anchor: ResearchCommentAnchor; body: string }>();
  commentRemoved = output<string>();

  sections = computed(() => parseMarkdownSections(this.content()));

  activeCommentSection: number | null = null;
  commentText = '';

  openCommentInput(sectionIndex: number): void {
    this.activeCommentSection = sectionIndex;
    this.commentText = '';
  }

  submitComment(section: MarkdownSection): void {
    if (!this.commentText.trim()) return;
    this.commentAdded.emit({
      anchor: {
        blockType: section.type,
        blockIndex: section.index,
        preview: section.preview,
      },
      body: this.commentText.trim(),
    });
    this.activeCommentSection = null;
    this.commentText = '';
  }

  cancelComment(): void {
    this.activeCommentSection = null;
    this.commentText = '';
  }

  getCommentsForSection(sectionIndex: number): ResearchComment[] {
    return this.pendingComments().filter(c => c.anchor.blockIndex === sectionIndex);
  }
}
