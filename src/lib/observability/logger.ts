type LogLevel = "debug" | "info" | "warn" | "error";

interface LogEntry {
  level: LogLevel;
  message: string;
  timestamp: string;
  context?: Record<string, unknown>;
}

/**
 * F16: one redaction point for everything this logger writes. Values under sensitive key names are replaced
 * wholesale; strings are scrubbed for credentials by shape (bearer tokens, provider API keys, token-like query
 * parameters, URL userinfo, `password=...` pairs). It reduces accidental disclosure; it is not a license to log secrets.
 */
const SENSITIVE_KEY = /(pass(word|wd|phrase)?|secret|token|authorization|cookie|api[-_]?key|credential|signature|private[-_]?key|session|otp|cvv|ssn)/i;
/** Usage counters share the word "token" but are not credentials. */
const NOT_SENSITIVE_KEY = /^(input|output|total|prompt|completion|max)?_?tokens?(_?(count|used|usage|limit))?$/i;
const REDACTED = "[REDACTED]";
const STRING_PATTERNS: Array<[RegExp, string]> = [
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{6,}/gi, `$1 ${REDACTED}`],
  [/\b(sk|pk|rk)-[A-Za-z0-9_-]{10,}/g, REDACTED],
  [/\b(ghp|gho|ghs|xox[abp])[-_][A-Za-z0-9_-]{10,}/g, REDACTED],
  [/\bwhsec_[A-Za-z0-9]{6,}/g, REDACTED],
  [/(\/\/[^\s/:@]+:)[^\s/@]+@/g, `$1${REDACTED}@`],
  [/([?&;\s](?:token|access_token|refresh_token|api[-_]?key|key|secret|password|passwd|pwd|code|signature|sig)=)[^&\s"']+/gi, `$1${REDACTED}`],
];

export function redactString(value: string): string {
  let out = value;
  for (const [pattern, replacement] of STRING_PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

/** `JSON.stringify` turns an Error into `{}`; keep what actually helps someone debug it. */
function serializeError(error: Error): Record<string, unknown> {
  const code = (error as { code?: unknown }).code;
  return { name: error.name, message: error.message, ...(code !== undefined && { code }), stack: error.stack };
}

function stringifyContext(context: Record<string, unknown>): string {
  const seen = new WeakSet<object>();
  try {
    return JSON.stringify(context, (key, value: unknown) => {
      if (key && SENSITIVE_KEY.test(key) && !NOT_SENSITIVE_KEY.test(key) && value !== null && value !== undefined && value !== "") return REDACTED;
      if (typeof value === "string") return redactString(value);
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
  return `[${entry.timestamp}] ${entry.level.toUpperCase()} ${redactString(entry.message)}${ctx}`;
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
