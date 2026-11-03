import type { LogLevel } from "../types/index.js";

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const LOG_COLORS: Record<LogLevel, string> = {
  debug: "\x1b[36m",    // cyan
  info: "\x1b[32m",     // green
  warn: "\x1b[33m",     // yellow
  error: "\x1b[31m",    // red
};

const RESET = "\x1b[0m";
const GRAY = "\x1b[90m";

let currentLevel: LogLevel = "info";

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

function timestamp(): string {
  return new Date().toISOString();
}

function shouldLog(level: LogLevel): boolean {
  return LOG_LEVELS[level] >= LOG_LEVELS[currentLevel];
}

function log(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
  if (!shouldLog(level)) return;

  const color = LOG_COLORS[level];
  const ts = timestamp();
  const metaStr = meta ? ` ${JSON.stringify(meta)}` : "";

  // Use stderr for all logs (stdout is reserved for MCP protocol)
  process.stderr.write(
    `${GRAY}${ts}${RESET} ${color}${level.toUpperCase()}${RESET} ${message}${metaStr}\n`
  );
}

export const logger = {
  debug: (message: string, meta?: Record<string, unknown>) => log("debug", message, meta),
  info: (message: string, meta?: Record<string, unknown>) => log("info", message, meta),
  warn: (message: string, meta?: Record<string, unknown>) => log("warn", message, meta),
  error: (message: string, meta?: Record<string, unknown>) => log("error", message, meta),
};