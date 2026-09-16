import { describe, it, expect, vi, beforeEach } from "vitest";
import { prisma } from "@/lib/prisma";
import { createRequest, parseJsonResponse } from "../helpers/request";
import { fixtures } from "../helpers/fixtures";

const mockPrisma = prisma as unknown as Record<string, Record<string, ReturnType<typeof vi.fn>>>;

describe("GET /api/conversations", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("should return list of conversations", async () => {
    mockPrisma.conversation.findMany.mockResolvedValue([
      {
        ...fixtures.conversation,
        messages: [fixtures.message],
        _count: { messages: 1 },
        tags: [],
      },
    ]);
    mockPrisma.conversation.count.mockResolvedValue(1);

    const { GET } = await import("@/app/api/conversations/route");
    const request = createRequest("/api/conversations");
    const response = await GET(request);
    const data = await parseJsonResponse(response);

    expect(response.status).toBe(200);
    expect(data.data).toHaveLength(1);
    expect(data.data[0].customerName).toBe("John Doe");
    expect(data.pagination.total).toBe(1);
  });

  it("should filter by channel", async () => {
    mockPrisma.conversation.findMany.mockResolvedValue([]);
    mockPrisma.conversation.count.mockResolvedValue(0);

    const { GET } = await import("@/app/api/conversations/route");
    const request = createRequest("/api/conversations", {
      searchParams: { channel: "email" },
    });
    await GET(request);

    expect(mockPrisma.conversation.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ channel: "email" }),
      })
    );
  });

  it("should filter by status", async () => {
    mockPrisma.conversation.findMany.mockResolvedValue([]);
    mockPrisma.conversation.count.mockResolvedValue(0);

    const { GET } = await import("@/app/api/conversations/route");
    const request = createRequest("/api/conversations", {
      searchParams: { status: "resolved" },
    });
    await GET(request);

    expect(mockPrisma.conversation.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: "resolved" }),
      })
    );
  });

  it("should filter by search term", async () => {
    mockPrisma.conversation.findMany.mockResolvedValue([]);
    mockPrisma.conversation.count.mockResolvedValue(0);

    const { GET } = await import("@/app/api/conversations/route");
    const request = createRequest("/api/conversations", {
      searchParams: { search: "john" },
    });
    await GET(request);

    expect(mockPrisma.conversation.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: expect.arrayContaining([
            expect.objectContaining({
              customerName: expect.objectContaining({ contains: "john" }),
            }),
          ]),
        }),
      })
    );
  });

  it("should handle errors gracefully", async () => {
    mockPrisma.conversation.findMany.mockRejectedValue(new Error("DB error"));

    const { GET } = await import("@/app/api/conversations/route");
    const request = createRequest("/api/conversations");
    const response = await GET(request);

    expect(response.status).toBe(500);
  });
});

describe("POST /api/conversations", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("should create a conversation", async () => {
    mockPrisma.conversation.create.mockResolvedValue({
      ...fixtures.conversation,
      messages: [],
      _count: { messages: 0 },
      tags: [],
    });

    const { POST } = await import("@/app/api/conversations/route");
    const request = createRequest("/api/conversations", {
      method: "POST",
      body: {
        channel: "whatsapp",
        customerName: "John Doe",
        customerContact: "+1555000111",
      },
    });

    const response = await POST(request);
    expect(response.status).toBe(201);
  });

  it("should reject missing channel", async () => {
    const { POST } = await import("@/app/api/conversations/route");
    const request = createRequest("/api/conversations", {
      method: "POST",
      body: { customerName: "John" },
    });

    const response = await POST(request);
    expect(response.status).toBe(400);
  });

  it("should reject non-string channel", async () => {
    const { POST } = await import("@/app/api/conversations/route");
    const request = createRequest("/api/conversations", {
      method: "POST",
      body: { channel: 123 },
    });

    const response = await POST(request);
    expect(response.status).toBe(400);
  });

  it("should default customerName to 'Unknown'", async () => {
    mockPrisma.conversation.create.mockResolvedValue({
      ...fixtures.conversation,
      customerName: "Unknown",
      messages: [],
      _count: { messages: 0 },
      tags: [],
    });

    const { POST } = await import("@/app/api/conversations/route");
    const request = createRequest("/api/conversations", {
      method: "POST",
      body: { channel: "email" },
    });

    await POST(request);

    expect(mockPrisma.conversation.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ customerName: "Unknown" }),
      })
    );
  });
});
