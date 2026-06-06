export type LogLevel = "trace" | "debug" | "info" | "warn" | "error";

const LEVEL_VALUES: Record<LogLevel, number> = {
  trace: 0,
  debug: 1,
  info: 2,
  warn: 3,
  error: 4,
};

export interface Logger {
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
  debug(message: string, data?: Record<string, unknown>): void;
}

// write のデフォルトは stdout。MCP stdio モードでは stdout が JSON-RPC 専用のため stderr を渡す。
export function createLogger(
  level: LogLevel,
  write: (line: string) => void = (line) => console.log(line),
): Logger {
  const log = (target: LogLevel, message: string, data?: Record<string, unknown>) => {
    if (LEVEL_VALUES[level] <= LEVEL_VALUES[target]) {
      const entry = { ...data, level: target, time: new Date().toISOString(), msg: message };
      write(JSON.stringify(entry));
    }
  };

  return {
    info: (msg, data) => log("info", msg, data),
    warn: (msg, data) => log("warn", msg, data),
    error: (msg, data) => log("error", msg, data),
    debug: (msg, data) => log("debug", msg, data),
  };
}

export function isLevelEnabled(configured: LogLevel, target: LogLevel): boolean {
  return LEVEL_VALUES[configured] <= LEVEL_VALUES[target];
}
