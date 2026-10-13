/**
 * Client-side live updates for the dashboard. One `EventSource` per browser tab,
 * shared by everything on the page that wants to know "something changed", so a
 * page plus the sidebar do not each hold a connection (browsers allow only a
 * handful per origin). Pure logic with the connection injected, so it is
 * unit-tested without a browser.
 */

export interface LiveEvent {
  type: string;
  conversationId?: string;
  data?: Record<string, unknown>;
  timestamp?: string;
}

/** The slice of `EventSource` the hub uses (`readyState`: 0 connecting, 1 open, 2 closed). */
export interface SourceLike {
  onmessage: ((event: { data: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  readyState: number;
  close(): void;
}

/** Events that change what a person sees; typing, presence and the greeting do not. */
const REFRESH_EVENT_TYPES: ReadonlySet<string> = new Set([
  "message:new",
  "message:updated",
  "conversation:new",
  "conversation:updated",
  "conversation:assigned",
  "ticket:new",
  "ticket:updated",
  "notification",
]);

export function parseLiveEvent(raw: string): LiveEvent | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (value && typeof value === "object" && typeof (value as { type?: unknown }).type === "string") return value as LiveEvent;
  } catch {
    // Not JSON: ignore the frame.
  }
  return null;
}

export function shouldRefreshOn(event: Pick<LiveEvent, "type">): boolean {
  return REFRESH_EVENT_TYPES.has(event.type);
}

const SOURCE_CLOSED = 2;
const BACKOFF_START_MS = 5_000;
const BACKOFF_MAX_MS = 60_000;

export class LiveEventHub {
  private readonly listeners = new Set<(event: LiveEvent) => void>();
  private source: SourceLike | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private backoff = BACKOFF_START_MS;

  constructor(
    private readonly createSource: () => SourceLike,
    /** The server ended this session (sign-out elsewhere, expiry): the app should go to the login page. */
    private readonly onSessionEnded: () => void
  ) {}

  private suspended = false;

  /**
   * Closes the connection but keeps the subscribers. Called when the page is hidden for navigation
   * (`pagehide`): a page parked in the back/forward cache would otherwise keep its stream open, and a handful of
   * those exhaust the browser's per-host connection limit.
   */
  suspend(): void {
    this.suspended = true;
    this.close();
  }

  /** Reconnects after `suspend()` (`pageshow` from the back/forward cache), if anyone is still listening. */
  resume(): void {
    this.suspended = false;
    if (this.listeners.size > 0 && !this.source && !this.retryTimer) this.open();
  }

  subscribe(listener: (event: LiveEvent) => void): () => void {
    this.listeners.add(listener);
    if (!this.source && !this.retryTimer && !this.suspended) this.open();
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.close();
    };
  }

  private open(): void {
    const source = this.createSource();
    this.source = source;
    source.onmessage = (message) => {
      const event = parseLiveEvent(message.data);
      if (!event) return;
      this.backoff = BACKOFF_START_MS; // a working connection resets the retry delay
      if (event.type === "connected") return;
      if (event.type === "session_ended") {
        this.close();
        this.onSessionEnded();
        return;
      }
      for (const listener of [...this.listeners]) {
        try {
          listener(event);
        } catch {
          // One misbehaving subscriber must not starve the others.
        }
      }
    };
    source.onerror = () => {
      // CONNECTING means the browser is already retrying; only a CLOSED source needs us.
      if (source.readyState !== SOURCE_CLOSED || this.source !== source) return;
      this.source = null;
      if (this.listeners.size === 0) return;
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        if (this.listeners.size > 0 && !this.source) this.open();
      }, this.backoff);
      this.backoff = Math.min(this.backoff * 2, BACKOFF_MAX_MS);
    };
  }

  private close(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.source?.close();
    this.source = null;
    this.backoff = BACKOFF_START_MS;
  }
}
