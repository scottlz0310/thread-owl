// Structured logger interface
// TODO: implement with pino in Phase 1

export interface Logger {
  info(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  debug(message: string, data?: Record<string, unknown>): void;
}

export function createLogger(_level: string): Logger {
  throw new Error("not implemented");
}
