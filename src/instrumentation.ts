export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // L2.1: refuse to serve with an incomplete or unsafe production configuration (strict profile only).
    const { assertRuntimeConfig } = await import("@/lib/config/runtime-contract");
    assertRuntimeConfig(process.env, "web");
    const { registerShutdownHandlers } = await import("@/lib/prisma/shutdown");
    registerShutdownHandlers();

    // PLAN.md §46.7 acceptance-audit finding — registers every channel
    // adapter once at process startup, rather than relying on whichever
    // routes this specific web process happens to have handled a request
    // for already (see channels/bootstrap.ts's own header for why this
    // matters for a job picked up by this process).
    await import("@/lib/channels/bootstrap");

    // L2.2: open the shared Redis connection before the first request. Rate-limit and cache calls get a 250 ms
    // budget, and a cold connection can overrun it: the circuit breaker then opens and every replica silently counts
    // on its own for a few seconds (found by the multi-replica load test). Fire-and-forget; failure is already logged
    // and handled by the in-memory fallback.
    const { getSharedRedis } = await import("@/lib/redis/client");
    void getSharedRedis().catch(() => null);
  }
}
