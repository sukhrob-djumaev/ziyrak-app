"use client";

import { useEffect, useRef } from "react";
import { LiveEventHub, shouldRefreshOn, type SourceLike } from "@/lib/live/hub";

let hub: LiveEventHub | null = null;
function getHub(): LiveEventHub {
  hub ??= new LiveEventHub(
    () => new EventSource("/api/realtime?channel=global") as unknown as SourceLike,
    () => window.location.assign("/login")
  );
  return hub;
}

interface Options {
  /** Safety-net poll, for changes made in another process (the worker) when no shared event bus is configured. */
  intervalMs?: number;
  /** Events usually arrive in bursts (a message, then a status change); refresh once. */
  debounceMs?: number;
}

/**
 * Calls `refresh` when something changed — immediately-ish on a server event,
 * and on a slow poll as a fallback — but only while the tab is visible, with one
 * catch-up refresh when it becomes visible again. `refresh` should be a quiet
 * background reload (no spinners).
 */
export function useLiveRefresh(refresh: () => void, { intervalMs = 20_000, debounceMs = 800 }: Options = {}): void {
  const latest = useRef(refresh);
  useEffect(() => {
    latest.current = refresh;
  });

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let missedWhileHidden = false;

    const run = () => {
      if (document.visibilityState !== "visible") {
        missedWhileHidden = true;
        return;
      }
      latest.current();
    };

    const stopEvents = getHub().subscribe((event) => {
      if (!shouldRefreshOn(event)) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(run, debounceMs);
    });
    const poll = setInterval(run, intervalMs);
    const onVisible = () => {
      if (document.visibilityState === "visible" && missedWhileHidden) {
        missedWhileHidden = false;
        latest.current();
      }
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      stopEvents();
      clearInterval(poll);
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [intervalMs, debounceMs]);
}
