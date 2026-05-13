/**
 * Environment-aware logging utility
 * Provides structured logging with levels (debug, info, warn, error)
 * In production, only logs warnings and errors
 */

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const isDevelopment = process.env.NODE_ENV === 'development' || 
                      (typeof window !== 'undefined' && 
                       (window.location?.hostname === 'localhost' || 
                        window.location?.hostname === '127.0.0.1'));

class Logger {
  private shouldLog(level: LogLevel): boolean {
    if (isDevelopment) {
      return true; // Log everything in development
    }
    // In production, only log warnings and errors
    return level === 'warn' || level === 'error';
  }

  private formatMessage(level: LogLevel, message: string, ...args: any[]): void {
    if (!this.shouldLog(level)) {
      return;
    }

    const timestamp = new Date().toISOString();
    const prefix = `[${timestamp}] [${level.toUpperCase()}]`;

    switch (level) {
      case 'debug':
        console.debug(prefix, message, ...args);
        break;
      case 'info':
        console.info(prefix, message, ...args);
        break;
      case 'warn':
        console.warn(prefix, message, ...args);
        break;
      case 'error':
        console.error(prefix, message, ...args);
        break;
    }
  }

  debug(message: string, ...args: any[]): void {
    this.formatMessage('debug', message, ...args);
  }

  info(message: string, ...args: any[]): void {
    this.formatMessage('info', message, ...args);
  }

  warn(message: string, ...args: any[]): void {
    this.formatMessage('warn', message, ...args);
  }

  error(message: string, ...args: any[]): void {
    this.formatMessage('error', message, ...args);
  }
}

// Singleton instance
export const logger = new Logger();


