/**
 * Code Block Component - Syntax highlighted code display
 */

import { Component, input, OnInit, OnChanges, SimpleChanges } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import hljs from 'highlight.js';

@Component({
  selector: 'app-code-block',
  standalone: true,
  imports: [
    CommonModule,
    MatIconModule,
    MatButtonModule,
    MatTooltipModule,
    MatSnackBarModule
  ],
  templateUrl: './code-block.component.html',
  styleUrl: './code-block.component.scss'
})
export class CodeBlockComponent implements OnInit, OnChanges {
  code = input.required<string>();
  language = input<string>('plaintext');

  highlightedCode = '';

  constructor(private snackBar: MatSnackBar) {}

  ngOnInit(): void {
    this.highlight();
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['code'] || changes['language']) {
      this.highlight();
    }
  }

  private highlight(): void {
    const lang = this.language();
    const codeText = this.code();

    try {
      if (lang && hljs.getLanguage(lang)) {
        this.highlightedCode = hljs.highlight(codeText, { language: lang }).value;
      } else {
        this.highlightedCode = hljs.highlightAuto(codeText).value;
      }
    } catch {
      this.highlightedCode = this.escapeHtml(codeText);
    }
  }

  private escapeHtml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  async copyCode(): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.code());
      this.snackBar.open('Code copied to clipboard', 'Dismiss', {
        duration: 2000,
        horizontalPosition: 'center',
        verticalPosition: 'bottom'
      });
    } catch {
      this.snackBar.open('Failed to copy code', 'Dismiss', {
        duration: 2000
      });
    }
  }
}
