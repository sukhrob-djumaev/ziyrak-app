import { describe, it, expect, vi, beforeEach } from "vitest";
import { prisma } from "@/lib/prisma";
import { createRequest, parseJsonResponse } from "../helpers/request";
import { fixtures } from "../helpers/fixtures";

const mockPrisma = prisma as unknown as Record<string, Record<string, ReturnType<typeof vi.fn>>>;

describe("GET /api/tickets", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("should return list of tickets", async () => {
    mockPrisma.ticket.findMany.mockResolvedValue([
      {
        ...fixtures.ticket,
        conversation: { id: "conv-1", customerName: "John", channel: "email", status: "active" },
        department: { id: "dept-1", name: "Support" },
        assignedTo: null,
      },
    ]);
    mockPrisma.ticket.count.mockResolvedValue(1);

    const { GET } = await import("@/app/api/tickets/route");
    const request = createRequest("/api/tickets");
    const response = await GET(request);
    const data = await parseJsonResponse(response);

    expect(response.status).toBe(200);
    expect(data.data).toHaveLength(1);
    expect(data.data[0].title).toBe("Order not delivered");
    expect(data.pagination.total).toBe(1);
  });

  it("should filter by status", async () => {
    mockPrisma.ticket.findMany.mockResolvedValue([]);
    mockPrisma.ticket.count.mockResolvedValue(0);

    const { GET } = await import("@/app/api/tickets/route");
    const request = createRequest("/api/tickets", {
      searchParams: { status: "open" },
    });
    await GET(request);

    expect(mockPrisma.ticket.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: "open" }),
      })
    );
  });

  it("should filter by priority", async () => {
    mockPrisma.ticket.findMany.mockResolvedValue([]);
    mockPrisma.ticket.count.mockResolvedValue(0);

    const { GET } = await import("@/app/api/tickets/route");
    const request = createRequest("/api/tickets", {
      searchParams: { priority: "high" },
    });
    await GET(request);

    expect(mockPrisma.ticket.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ priority: "high" }),
      })
    );
  });

  it("should handle database errors", async () => {
    mockPrisma.ticket.findMany.mockRejectedValue(new Error("DB error"));

    const { GET } = await import("@/app/api/tickets/route");
    const request = createRequest("/api/tickets");
    const response = await GET(request);

    expect(response.status).toBe(500);
  });
});

describe("POST /api/tickets", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("should create a ticket with valid data", async () => {
    mockPrisma.ticket.create.mockResolvedValue({
      ...fixtures.ticket,
      conversation: null,
      department: null,
      assignedTo: null,
    });

    const { POST } = await import("@/app/api/tickets/route");
    const request = createRequest("/api/tickets", {
      method: "POST",
      body: {
        title: "Order not delivered",
        description: "Customer reports order #123 not delivered",
        priority: "high",
      },
    });

    const response = await POST(request);
    expect(response.status).toBe(201);
  });

  it("should reject empty title", async () => {
    const { POST } = await import("@/app/api/tickets/route");
    const request = createRequest("/api/tickets", {
      method: "POST",
      body: { title: "", description: "Details" },
    });

    const response = await POST(request);
    expect(response.status).toBe(400);
  });

  it("should reject missing title", async () => {
    const { POST } = await import("@/app/api/tickets/route");
    const request = createRequest("/api/tickets", {
      method: "POST",
      body: { description: "No title provided" },
    });

    const response = await POST(request);
    expect(response.status).toBe(400);
  });

  it("should default priority to 'medium'", async () => {
    mockPrisma.ticket.create.mockResolvedValue({
      ...fixtures.ticket,
      priority: "medium",
      conversation: null,
      department: null,
      assignedTo: null,
    });

    const { POST } = await import("@/app/api/tickets/route");
    const request = createRequest("/api/tickets", {
      method: "POST",
      body: { title: "Simple issue" },
    });

    await POST(request);

    expect(mockPrisma.ticket.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ priority: "medium" }),
      })
    );
  });
});
