type LogLevel = "debug" | "info" | "warn" | "error";

interface LogEntry {
  level: LogLevel;
  message: string;
  timestamp: string;
  context?: Record<string, unknown>;
}

/** `JSON.stringify` turns an Error into `{}`; keep what actually helps someone debug it. */
function serializeError(error: Error): Record<string, unknown> {
  const code = (error as { code?: unknown }).code;
  return { name: error.name, message: error.message, ...(code !== undefined && { code }), stack: error.stack };
}

function stringifyContext(context: Record<string, unknown>): string {
  const seen = new WeakSet<object>();
  try {
    return JSON.stringify(context, (_key, value: unknown) => {
      if (value instanceof Error) return serializeError(value);
      if (typeof value === "object" && value !== null) {
        if (seen.has(value)) return "[Circular]";
        seen.add(value);
      }
      return value;
    });
  } catch {
    return '{"unserializable":true}';
  }
}

function formatEntry(entry: LogEntry): string {
  const ctx = entry.context ? ` ${stringifyContext(entry.context)}` : "";
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

  /**
   * `error` is usually an Error, but call sites also pass a context object as the
   * second argument (`logger.error("job failed", { businessId, error })`); that is
   * merged as context instead of being flattened to "[object Object]".
   */
  error(message: string, error?: unknown, context?: Record<string, unknown>) {
    const fromError: Record<string, unknown> =
      error instanceof Error
        ? { error: error.message, stack: error.stack }
        : error !== null && typeof error === "object" && !Array.isArray(error)
          ? (error as Record<string, unknown>)
          : error != null
            ? { error: String(error) }
            : {};
    const entry = createEntry("error", message, { ...context, ...fromError });
    console.error(formatEntry(entry));
  },
};
