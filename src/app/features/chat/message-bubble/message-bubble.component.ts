/**
 * Message Bubble Component - Individual chat message
 */

import { Component, input, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatIconModule } from '@angular/material/icon';
import { marked } from 'marked';

import { CodeBlockComponent } from '../code-block/code-block.component';
import type { ChatMessage, ToolCall } from '../../../../shared/types/message.types';

// Configure marked for chat rendering
marked.setOptions({
  breaks: true,
  gfm: true,
});

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
  streamingThinking = input<string>('');
  streamingToolCalls = input<ToolCall[] | undefined>(undefined);
  isStreaming = input<boolean>(false);
  agentName = input<string>('Agent');
  agentIcon = input<string | undefined>(undefined);

  /** Max visible tool calls when streaming; older ones are collapsed */
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

  get thinking(): string {
    if (this.isStreaming()) {
      return this.streamingThinking();
    }
    return '';
  }

  get timestamp(): Date | undefined {
    return this.message()?.timestamp;
  }

  get activeToolCalls(): ToolCall[] {
    const calls = this.isStreaming()
      ? (this.streamingToolCalls() || [])
      : (this.message()?.metadata?.toolCalls || []);
    return calls;
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
    return this.isStreaming() && !this.content && (this.activeToolCalls.length > 0 || !!this.thinking);
  }

  // Parse content for code blocks
  get parsedContent(): Array<{ type: 'text' | 'code'; content: string; language?: string }> {
    const content = this.content;
    const parts: Array<{ type: 'text' | 'code'; content: string; language?: string }> = [];
    
    // Regex to match code blocks
    const codeBlockRegex = /```(\w+)?\n([\s\S]*?)```/g;
    let lastIndex = 0;
    let match;

    while ((match = codeBlockRegex.exec(content)) !== null) {
      // Add text before code block
      if (match.index > lastIndex) {
        const text = content.slice(lastIndex, match.index).trim();
        if (text) {
          parts.push({ type: 'text', content: text });
        }
      }

      // Add code block
      parts.push({
        type: 'code',
        content: match[2].trim(),
        language: match[1] || 'plaintext'
      });

      lastIndex = match.index + match[0].length;
    }

    // Add remaining text
    if (lastIndex < content.length) {
      const text = content.slice(lastIndex).trim();
      if (text) {
        parts.push({ type: 'text', content: text });
      }
    }

    // If no parts, return the whole content as text
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
