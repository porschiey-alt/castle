/**
 * Message Bubble Component - Individual chat message
 */

import { Component, input, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatIconModule } from '@angular/material/icon';
import { marked, Renderer } from 'marked';
import hljs from 'highlight.js';

import { AgentIconComponent } from '../../../shared/components/agent-icon/agent-icon.component';
import type { ChatMessage, ToolCall, MessageSegment } from '../../../../shared/types/message.types';

// Custom renderer so fenced code blocks get syntax highlighting + copy button
const renderer = new Renderer();
renderer.code = function(code: string, infostring: string | undefined): string {
  const lang = (infostring || '').match(/^\S*/)?.[0] || '';
  const language = lang || 'plaintext';
  let highlighted: string;
  try {
    if (lang && hljs.getLanguage(lang)) {
      highlighted = hljs.highlight(code, { language: lang }).value;
    } else {
      highlighted = hljs.highlightAuto(code).value;
    }
  } catch {
    highlighted = code
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }
  return `<div class="code-block-inline"><div class="code-header"><span class="language-label">${language}</span><button class="copy-code-btn" title="Copy code"><span class="material-icons">content_copy</span></button></div><pre class="code-content"><code>${highlighted}</code></pre></div>`;
};

// Configure marked for chat rendering
marked.setOptions({
  breaks: true,
  gfm: true,
  renderer,
});

/** Resolved tool-calls segment with visible/hidden split */
interface ResolvedToolCallsSegment {
  type: 'tool-calls';
  visibleToolCalls: ToolCall[];
  hiddenCount: number;
}

/** Resolved text segment */
interface ResolvedTextSegment {
  type: 'text';
  content: string;
}

export type ResolvedSegment = ResolvedToolCallsSegment | ResolvedTextSegment;

@Component({
  selector: 'app-message-bubble',
  standalone: true,
  imports: [
    CommonModule,
    MatIconModule,
    AgentIconComponent,
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
        content: seg.content
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

  /** Render a markdown text fragment to HTML */
  renderMarkdown(text: string): string {
    return marked.parse(text, { async: false }) as string;
  }

  /** Handle clicks inside rendered markdown (e.g. copy-code buttons) */
  onContentClick(event: MouseEvent): void {
    const target = event.target as HTMLElement;
    const copyBtn = target.closest('.copy-code-btn');
    if (copyBtn) {
      event.preventDefault();
      const codeBlock = copyBtn.closest('.code-block-inline');
      const codeEl = codeBlock?.querySelector('code');
      if (codeEl) {
        navigator.clipboard.writeText(codeEl.textContent || '');
        // Brief visual feedback
        const icon = copyBtn.querySelector('.material-icons');
        if (icon) {
          const prev = icon.textContent;
          icon.textContent = 'check';
          setTimeout(() => { icon.textContent = prev; }, 1500);
        }
      }
    }
  }
}
