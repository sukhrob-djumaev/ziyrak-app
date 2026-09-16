type LogLevel = "debug" | "info" | "warn" | "error";

interface LogEntry {
  level: LogLevel;
  message: string;
  timestamp: string;
  context?: Record<string, unknown>;
}

function formatEntry(entry: LogEntry): string {
  const ctx = entry.context
    ? ` ${JSON.stringify(entry.context)}`
    : "";
  return `[${entry.timestamp}] ${entry.level.toUpperCase()} ${entry.message}${ctx}`;
}

function createEntry(
  level: LogLevel,
  message: string,
  context?: Record<string, unknown>
): LogEntry {
  return {
    level,
    message,
    timestamp: new Date().toISOString(),
    context,
  };
}

export const logger = {
  debug(message: string, context?: Record<string, unknown>) {
    if (process.env.NODE_ENV === "production") return;
    const entry = createEntry("debug", message, context);
    console.debug(formatEntry(entry));
  },

  info(message: string, context?: Record<string, unknown>) {
    const entry = createEntry("info", message, context);
    console.info(formatEntry(entry));
  },

  warn(message: string, context?: Record<string, unknown>) {
    const entry = createEntry("warn", message, context);
    console.warn(formatEntry(entry));
  },

  error(message: string, error?: unknown, context?: Record<string, unknown>) {
    const entry = createEntry("error", message, {
      ...context,
      ...(error instanceof Error
        ? { error: error.message, stack: error.stack }
        : error != null
          ? { error: String(error) }
          : {}),
    });
    console.error(formatEntry(entry));
  },
};
