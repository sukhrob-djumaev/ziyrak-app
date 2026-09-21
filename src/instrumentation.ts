export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { registerShutdownHandlers } = await import("@/lib/prisma/shutdown");
    registerShutdownHandlers();

    // PLAN.md §46.7 acceptance-audit finding — registers every channel
    // adapter once at process startup, rather than relying on whichever
    // routes this specific web process happens to have handled a request
    // for already (see channels/bootstrap.ts's own header for why this
    // matters for a job picked up by this process).
    await import("@/lib/channels/bootstrap");
  }
}
