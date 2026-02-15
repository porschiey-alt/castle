/**
 * Chat Input Component - Message input area
 */

import { Component, input, output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { TextFieldModule } from '@angular/cdk/text-field';

@Component({
  selector: 'app-chat-input',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    MatFormFieldModule,
    MatInputModule,
    MatButtonModule,
    MatIconModule,
    MatProgressSpinnerModule,
    TextFieldModule
  ],
  templateUrl: './chat-input.component.html',
  styleUrl: './chat-input.component.scss'
})
export class ChatInputComponent {
  // Inputs
  agentName = input<string>('');
  isLoading = input<boolean>(false);
  disabled = input<boolean>(false);

  // Outputs
  messageSent = output<string>();

  // Local state
  message = '';

  onSend(event?: KeyboardEvent): void {
    // If it's a keyboard event, only send on Enter without Shift
    if (event && event.shiftKey) {
      return;
    }

    if (event) {
      event.preventDefault();
    }

    const trimmedMessage = this.message.trim();
    if (trimmedMessage && !this.isLoading() && !this.disabled()) {
      this.messageSent.emit(trimmedMessage);
      this.message = '';
    }
  }

  onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter' && !event.shiftKey) {
      this.onSend(event);
    }
  }
}
