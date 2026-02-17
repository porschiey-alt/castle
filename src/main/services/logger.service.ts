/**
 * Logger Service - Structured logging for the main process
 *
 * Provides consistent log formatting with timestamps, severity levels,
 * and category tags across all main-process services.
 *
 * Log levels (in order): debug < info < warn < error
 * Default minimum level is 'info'. Set to 'debug' for verbose output.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

let minLevel: LogLevel = 'info';

/** Set the minimum log level. Messages below this level are suppressed. */
export function setLogLevel(level: LogLevel): void {
  minLevel = level;
}

export function getLogLevel(): LogLevel {
  return minLevel;
}

function shouldLog(level: LogLevel): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[minLevel];
}

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

  debug(message: string, data?: unknown): void {
    if (!shouldLog('debug')) return;
    console.log(formatMessage('debug', this.category, message, data));
  }

  info(message: string, data?: unknown): void {
    if (!shouldLog('info')) return;
    console.log(formatMessage('info', this.category, message, data));
  }

  warn(message: string, data?: unknown): void {
    if (!shouldLog('warn')) return;
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
