"use client";

import { useRouter } from "next/navigation";
import { useLiveRefresh } from "@/lib/hooks/use-live-refresh";

/** Keeps a server-rendered page current: re-runs its server data fetch when something changes. Renders nothing. */
export function LiveRefresh({ intervalMs = 30_000 }: { intervalMs?: number }) {
  const router = useRouter();
  useLiveRefresh(() => router.refresh(), { intervalMs });
  return null;
}
