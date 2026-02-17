/**
 * Message Bubble Component - Individual chat message
 */

import { Component, input, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatIconModule } from '@angular/material/icon';
import { marked } from 'marked';

import { CodeBlockComponent } from '../code-block/code-block.component';
import type { ChatMessage, ToolCall, MessageSegment } from '../../../../shared/types/message.types';

// Configure marked for chat rendering
marked.setOptions({
  breaks: true,
  gfm: true,
});

/** Resolved tool-calls segment with visible/hidden split */
interface ResolvedToolCallsSegment {
  type: 'tool-calls';
  visibleToolCalls: ToolCall[];
  hiddenCount: number;
}

/** Resolved text segment with parsed content blocks */
interface ResolvedTextSegment {
  type: 'text';
  parsedContent: Array<{ type: 'text' | 'code'; content: string; language?: string }>;
}

export type ResolvedSegment = ResolvedToolCallsSegment | ResolvedTextSegment;

@Component({
  selector: 'app-message-bubble',
  standalone: true,
  imports: [
    CommonModule,
    MatIconModule,
    CodeBlockComponent
  ],
  templateUrl: './message-bubble.component.html',
  styleUrl: './message-bubble.component.scss'
})
export class MessageBubbleComponent {
  // Inputs
  message = input<ChatMessage | undefined>(undefined);
  streamingContent = input<string>('');
  streamingToolCalls = input<ToolCall[] | undefined>(undefined);
  streamingSegments = input<MessageSegment[] | undefined>(undefined);
  isStreaming = input<boolean>(false);
  agentName = input<string>('Agent');
  agentIcon = input<string | undefined>(undefined);

  /** Max visible tool calls per segment; older ones are collapsed */
  private readonly MAX_VISIBLE_TOOLS = 5;

  get isUser(): boolean {
    return this.message()?.role === 'user';
  }

  get content(): string {
    if (this.isStreaming()) {
      return this.streamingContent();
    }
    return this.message()?.content || '';
  }

  get timestamp(): Date | undefined {
    return this.message()?.timestamp;
  }

  /** Whether we have segment data to render interleaved layout */
  get hasSegments(): boolean {
    if (this.isStreaming()) {
      return (this.streamingSegments() || []).length > 0;
    }
    return (this.message()?.metadata?.segments || []).length > 0;
  }

  /** Resolved segments for interleaved rendering */
  get resolvedSegments(): ResolvedSegment[] {
    const segments = this.isStreaming()
      ? (this.streamingSegments() || [])
      : (this.message()?.metadata?.segments || []);
    return segments.map(seg => {
      if (seg.type === 'tool-calls') {
        const all = seg.toolCalls;
        const visible = all.length <= this.MAX_VISIBLE_TOOLS
          ? all
          : all.slice(all.length - this.MAX_VISIBLE_TOOLS);
        return {
          type: 'tool-calls' as const,
          visibleToolCalls: visible,
          hiddenCount: Math.max(0, all.length - this.MAX_VISIBLE_TOOLS)
        };
      }
      return {
        type: 'text' as const,
        parsedContent: this.parseContent(seg.content)
      };
    });
  }

  // Legacy accessors for non-streaming (historical) messages
  get activeToolCalls(): ToolCall[] {
    return this.message()?.metadata?.toolCalls || [];
  }

  get visibleToolCalls(): ToolCall[] {
    const all = this.activeToolCalls;
    if (all.length <= this.MAX_VISIBLE_TOOLS) return all;
    return all.slice(all.length - this.MAX_VISIBLE_TOOLS);
  }

  get hiddenToolCallCount(): number {
    const all = this.activeToolCalls;
    return Math.max(0, all.length - this.MAX_VISIBLE_TOOLS);
  }

  /** True when the agent is working but has no text content yet */
  get isProcessing(): boolean {
    if (!this.isStreaming()) return false;
    const hasToolCalls = (this.streamingToolCalls() || []).length > 0;
    return !this.content && hasToolCalls;
  }

  // Parse content for code blocks
  get parsedContent(): Array<{ type: 'text' | 'code'; content: string; language?: string }> {
    return this.parseContent(this.content);
  }

  /** Parse a content string into text and code block parts */
  private parseContent(content: string): Array<{ type: 'text' | 'code'; content: string; language?: string }> {
    const parts: Array<{ type: 'text' | 'code'; content: string; language?: string }> = [];

    const codeBlockRegex = /```(\w+)?\n([\s\S]*?)```/g;
    let lastIndex = 0;
    let match;

    while ((match = codeBlockRegex.exec(content)) !== null) {
      if (match.index > lastIndex) {
        const text = content.slice(lastIndex, match.index).trim();
        if (text) {
          parts.push({ type: 'text', content: text });
        }
      }

      parts.push({
        type: 'code',
        content: match[2].trim(),
        language: match[1] || 'plaintext'
      });

      lastIndex = match.index + match[0].length;
    }

    if (lastIndex < content.length) {
      const text = content.slice(lastIndex).trim();
      if (text) {
        parts.push({ type: 'text', content: text });
      }
    }

    if (parts.length === 0 && content) {
      parts.push({ type: 'text', content });
    }

    return parts;
  }

  /** Render a markdown text fragment to HTML */
  renderMarkdown(text: string): string {
    return marked.parse(text, { async: false }) as string;
  }
}
