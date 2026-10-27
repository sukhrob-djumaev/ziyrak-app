export interface TimedMessage {
  conversationId: string;
  role: string;
  createdAt: Date | string;
}

/** Roles that start a wait: inbound records store `customer`; `user` is the older spelling. */
const INBOUND = new Set(["customer", "user"]);
/** Roles that answer it: the AI (`assistant`) or a human (`agent`). */
const REPLY = new Set(["assistant", "agent"]);

/**
 * Mean minutes from a conversation's first customer message to the first reply after it,
 * over conversations that have both. `sampleSize` is how many conversations the mean covers,
 * so a zero mean with no samples is distinguishable from instant replies. Input must be time-ordered.
 */
export function averageFirstResponse(messages: TimedMessage[]): { minutes: number; sampleSize: number } {
  const start = new Map<string, number>();
  const answered = new Map<string, number>();
  for (const m of messages) {
    const at = new Date(m.createdAt).getTime();
    if (INBOUND.has(m.role) && !start.has(m.conversationId)) start.set(m.conversationId, at);
    else if (REPLY.has(m.role) && start.has(m.conversationId) && !answered.has(m.conversationId)) {
      answered.set(m.conversationId, Math.max(0, at - start.get(m.conversationId)!) / 60000);
    }
  }
  const values = [...answered.values()];
  if (values.length === 0) return { minutes: 0, sampleSize: 0 };
  return { minutes: Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 10) / 10, sampleSize: values.length };
}
