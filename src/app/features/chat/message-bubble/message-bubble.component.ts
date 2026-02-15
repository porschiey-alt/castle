/**
 * Message Bubble Component - Individual chat message
 */

import { Component, input } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatIconModule } from '@angular/material/icon';

import { CodeBlockComponent } from '../code-block/code-block.component';
import type { ChatMessage } from '../../../../shared/types/message.types';

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
  isStreaming = input<boolean>(false);
  agentName = input<string>('Agent');
  agentIcon = input<string | undefined>(undefined);

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
}
