/**
 * Logger Service - Structured logging for the Angular renderer process
 */

import { Injectable } from '@angular/core';

export type LogLevel = 'info' | 'warn' | 'error';

@Injectable({
  providedIn: 'root'
})
export class LoggerService {
  private format(level: LogLevel, category: string, message: string): string {
    return `[${new Date().toISOString()}] [${level.toUpperCase()}] [${category}] ${message}`;
  }

  info(category: string, message: string, data?: unknown): void {
    const formatted = this.format('info', category, message);
    if (data !== undefined) {
      console.log(formatted, data);
    } else {
      console.log(formatted);
    }
  }

  warn(category: string, message: string, data?: unknown): void {
    const formatted = this.format('warn', category, message);
    if (data !== undefined) {
      console.warn(formatted, data);
    } else {
      console.warn(formatted);
    }
  }

  error(category: string, message: string, data?: unknown): void {
    const formatted = this.format('error', category, message);
    if (data !== undefined) {
      console.error(formatted, data);
    } else {
      console.error(formatted);
    }
  }
}
