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
  const base = `[${timestamp()}] [${level.toUpperCase()}] [${category}] ${message}`;
  return base;
}

class Logger {
  private category: string;

  constructor(category: string) {
    this.category = category;
  }

  info(message: string, data?: unknown): void {
    const formatted = formatMessage('info', this.category, message, data);
    if (data !== undefined) {
      console.log(formatted, data);
    } else {
      console.log(formatted);
    }
  }

  warn(message: string, data?: unknown): void {
    const formatted = formatMessage('warn', this.category, message, data);
    if (data !== undefined) {
      console.warn(formatted, data);
    } else {
      console.warn(formatted);
    }
  }

  error(message: string, data?: unknown): void {
    const formatted = formatMessage('error', this.category, message, data);
    if (data !== undefined) {
      console.error(formatted, data);
    } else {
      console.error(formatted);
    }
  }
}

/** Create a logger instance scoped to a category (e.g. 'ProcessManager', 'IPC') */
export function createLogger(category: string): Logger {
  return new Logger(category);
}
