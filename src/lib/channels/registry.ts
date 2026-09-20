import type { ChannelAdapter } from "./types";

/**
 * PLAN.md §19.3/§46.5 — "adding a channel means: implement ChannelAdapter
 * ..., register it in one ChannelRegistry, add one route ...". Each
 * adapter module registers itself at import time; `conversations/
 * inbound.ts`'s job handler looks an adapter up by `event.source.channel`
 * to deliver the AI's reply back out (§5.3's last step), so a worker never
 * needs a big per-channel switch statement to know how to send.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const registry = new Map<string, ChannelAdapter<any>>();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function registerChannelAdapter(type: string, adapter: ChannelAdapter<any>): void {
  registry.set(type, adapter);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getChannelAdapter(type: string): ChannelAdapter<any> | undefined {
  return registry.get(type);
}
