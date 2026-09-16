import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAuth, isAuthenticated } from "@/lib/route-auth";

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request, "analytics:read");
  if (!isAuthenticated(auth)) return auth;

  const [
    totalConversations,
    activeConversations,
    resolvedConversations,
    totalTickets,
    openTickets,
    totalMessages,
    channelBreakdown,
  ] = await Promise.all([
    prisma.conversation.count(),
    prisma.conversation.count({ where: { status: "active" } }),
    prisma.conversation.count({ where: { status: "resolved" } }),
    prisma.ticket.count(),
    prisma.ticket.count({ where: { status: "open" } }),
    prisma.message.count(),
    prisma.conversation.groupBy({
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
