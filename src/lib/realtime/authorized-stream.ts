import type { EventPayload } from "./realtime";

/** One ordered emission lane, including heartbeats. Cancellation invalidates
 * pending lookups before enqueue. A lookup failure never falls back to old data.
 */
export function authorizedEventStream<T>(options: {
  signal: AbortSignal;
  connected: Record<string, unknown>;
  subscribe: (callback: (event: EventPayload) => void) => () => void;
  refresh: () => Promise<T | null>;
  project: (authority: T, event: EventPayload) => Promise<EventPayload | null>;
}) {
  let close = () => {};
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      let closed = false,
        unsubscribe = () => {},
        heartbeat: ReturnType<typeof setInterval> | undefined = undefined;
      let lane = Promise.resolve(),
        pending = 0;
      const send = (value: unknown) =>
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(value)}\n\n`));
      close = () => {
        if (closed) return;
        closed = true;
        if (heartbeat) clearInterval(heartbeat);
        unsubscribe();
        options.signal.removeEventListener("abort", close);
        try {
          controller.close();
        } catch {
          /* Already cancelled. */
        }
      };
      const endAuthority = () => {
        if (!closed) {
          try {
            send({ type: "session_ended" });
          } catch {
            /* Closed reader. */
          }
          close();
        }
      };
      const schedule = (event?: EventPayload) => {
        if (closed) return;
        if (++pending > 100) {
          endAuthority();
          return;
        }
        lane = lane
          .then(async () => {
            if (closed) return;
            const authority = await options.refresh();
            if (closed) return;
            if (!authority) {
              endAuthority();
              return;
            }
            if (event) {
              const projected = await options.project(authority, event);
              if (closed || !projected) return;
              // A projection can await persistence. Recheck before using it;
              // changed authority discards this hint rather than stale content.
              const latest = await options.refresh();
              if (closed) return;
              if (!latest) {
                endAuthority();
                return;
              }
              if (JSON.stringify(authority) !== JSON.stringify(latest)) return;
              // Erasure can commit while the first projection awaits. Its
              // resource lifetime is independent of membership lifetime.
              const finalProjection = await options.project(latest, event);
              if (closed || !finalProjection) return;
              const atEmission = await options.refresh();
              if (closed) return;
              if (!atEmission) {
                endAuthority();
                return;
              }
              if (JSON.stringify(latest) === JSON.stringify(atEmission)) send(finalProjection);
            } else if (!closed) controller.enqueue(encoder.encode(": heartbeat\n\n"));
          })
          .catch(endAuthority)
          .finally(() => {
            pending--;
          });
      };
      if (options.signal.aborted) {
        close();
        return;
      }
      options.signal.addEventListener("abort", close, { once: true });
      send(options.connected);
      unsubscribe = options.subscribe((event) => schedule(event));
      heartbeat = setInterval(() => schedule(), 30_000);
    },
    cancel() {
      close();
    },
  });
}
