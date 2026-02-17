/**
 * Logger Service - Structured logging for the main process
 *
 * Provides consistent log formatting with timestamps, severity levels,
 * and category tags across all main-process services.
 */

export type LogLevel = 'info' | 'warn' | 'error';

function timestamp(): string {
  return new Date().toISOString();
}

function formatMessage(level: LogLevel, category: string, message: string, data?: unknown): string {
  const dataStr = data !== undefined ? ' ' + JSON.stringify(data, null, 0) : '';
  return `[${timestamp()}] [${level.toUpperCase().padEnd(5)}] [${category}] ${message}${dataStr}`;
}

class Logger {
  private category: string;

  constructor(category: string) {
    this.category = category;
  }

  info(message: string, data?: unknown): void {
    console.log(formatMessage('info', this.category, message, data));
  }

  warn(message: string, data?: unknown): void {
    console.warn(formatMessage('warn', this.category, message, data));
  }

  error(message: string, data?: unknown): void {
    console.error(formatMessage('error', this.category, message, data));
  }
}

/** Create a logger instance scoped to a category (e.g. 'ProcessManager', 'IPC') */
export function createLogger(category: string): Logger {
  return new Logger(category);
}
