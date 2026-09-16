import { describe, it, expect, vi, beforeEach } from "vitest";
import { prisma } from "@/lib/prisma";
import { createRequest, parseJsonResponse } from "../helpers/request";

const mockPrisma = prisma as unknown as Record<string, Record<string, ReturnType<typeof vi.fn>>>;

describe("GET /api/export", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("should export conversations as JSON with limit", async () => {
    const mockConversations = [
      { id: "conv-1", channel: "email", customerName: "John", messages: [], tickets: [], tags: [], createdAt: new Date() },
    ];
    mockPrisma.conversation.findMany.mockResolvedValue(mockConversations);

    const { GET } = await import("@/app/api/export/route");
    const request = createRequest("/api/export", {
      searchParams: { type: "conversations", format: "json" },
    });

    const response = await GET(request);
    const data = await parseJsonResponse(response);

    expect(response.status).toBe(200);
    expect(data.data).toHaveLength(1);
    expect(data.total).toBe(1);
  });

  it("should export conversations as CSV", async () => {
    mockPrisma.conversation.findMany.mockResolvedValue([
      {
        id: "conv-1", channel: "email", customerName: "John", customerContact: "john@test.com",
        status: "active", messages: [{ id: "m1" }], createdAt: new Date("2025-01-01"), updatedAt: new Date("2025-01-02"),
      },
    ]);

    const { GET } = await import("@/app/api/export/route");
    const request = createRequest("/api/export", {
      searchParams: { type: "conversations", format: "csv" },
    });

    const response = await GET(request);

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/csv");
    expect(response.headers.get("Content-Disposition")).toContain("conversations-");

    const text = await response.text();
    expect(text).toContain("ID,Channel,Customer Name");
    expect(text).toContain("conv-1");
  });

  it("should export tickets", async () => {
    mockPrisma.ticket.findMany.mockResolvedValue([
      {
        id: "t-1", title: "Bug", status: "open", priority: "high",
        department: { name: "Support" }, assignedTo: null, createdAt: new Date(),
      },
    ]);

    const { GET } = await import("@/app/api/export/route");
    const request = createRequest("/api/export", {
      searchParams: { type: "tickets", format: "json" },
    });

    const response = await GET(request);
    const data = await parseJsonResponse(response);

    expect(data.data).toHaveLength(1);
  });

  it("should export customers", async () => {
    mockPrisma.customer.findMany.mockResolvedValue([
      {
        id: "c-1", name: "Jane", email: "jane@test.com", phone: "", whatsapp: "",
        tags: "vip", isBlocked: false, firstContact: new Date(), lastContact: new Date(),
      },
    ]);

    const { GET } = await import("@/app/api/export/route");
    const request = createRequest("/api/export", {
      searchParams: { type: "customers", format: "json" },
    });

    const response = await GET(request);
    const data = await parseJsonResponse(response);

    expect(data.data).toHaveLength(1);
  });

  it("should export knowledge base", async () => {
    mockPrisma.knowledgeEntry.findMany.mockResolvedValue([
      {
        id: "k-1", title: "FAQ", content: "Answer here", priority: 10,
        isActive: true, category: { name: "General" },
      },
    ]);

    const { GET } = await import("@/app/api/export/route");
    const request = createRequest("/api/export", {
      searchParams: { type: "knowledge", format: "json" },
    });

    const response = await GET(request);
    const data = await parseJsonResponse(response);

    expect(data.data).toHaveLength(1);
  });

  it("should reject invalid export type", async () => {
    const { GET } = await import("@/app/api/export/route");
    const request = createRequest("/api/export", {
      searchParams: { type: "invalid" },
    });

    const response = await GET(request);
    expect(response.status).toBe(400);
  });

  it("should respect limit parameter", async () => {
    mockPrisma.conversation.findMany.mockResolvedValue([]);

    const { GET } = await import("@/app/api/export/route");
    const request = createRequest("/api/export", {
      searchParams: { type: "conversations", limit: "5" },
    });

    await GET(request);

    expect(mockPrisma.conversation.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 5 })
    );
  });

  it("should cap limit at 50000", async () => {
    mockPrisma.conversation.findMany.mockResolvedValue([]);

    const { GET } = await import("@/app/api/export/route");
    const request = createRequest("/api/export", {
      searchParams: { type: "conversations", limit: "999999" },
    });

    await GET(request);

    expect(mockPrisma.conversation.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 50000 })
    );
  });
});
