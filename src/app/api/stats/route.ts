import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthenticated } from "@/lib/route-auth";
import { getScopedPrisma } from "@/lib/tenancy/scoped-prisma";

export async function GET(request: NextRequest) {
  const ctx = await requireAuth(request, "analytics:read");
  if (!isAuthenticated(ctx)) return ctx;

  const db = getScopedPrisma(ctx);
  const [
    totalConversations,
    activeConversations,
    resolvedConversations,
    totalTickets,
    openTickets,
    totalMessages,
    channelBreakdown,
  ] = await Promise.all([
    db.conversation.count(),
    db.conversation.count({ where: { status: "active" } }),
    db.conversation.count({ where: { status: "resolved" } }),
    db.ticket.count(),
    db.ticket.count({ where: { status: "open" } }),
    db.message.count(),
    db.conversation.groupBy({
      by: ["channel"],
      _count: { id: true },
    }),
  ]);

  const resolutionRate =
    totalConversations > 0
      ? Math.round((resolvedConversations / totalConversations) * 100)
      : 0;

  const channels = channelBreakdown.reduce(
    (acc, item) => {
      acc[item.channel] = item._count.id;
      return acc;
    },
    {} as Record<string, number>
  );

  return NextResponse.json({
    totalConversations,
    activeConversations,
    resolvedConversations,
    totalTickets,
    openTickets,
    totalMessages,
    resolutionRate,
    channels,
  });
}
