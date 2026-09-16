import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import jwt from "jsonwebtoken";
import { _getStoreForTesting } from "@/lib/rate-limit";

// Mock rate-limit module with real implementation
vi.mock("@/lib/rate-limit", async (importOriginal) => {
  return importOriginal();
});

describe("Proxy", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    _getStoreForTesting().clear();
  });

  function createProxyRequest(
    path: string,
    options: { cookies?: Record<string, string>; headers?: Record<string, string> } = {}
  ): NextRequest {
    const url = new URL(path, "http://localhost:3000");
    const request = new NextRequest(url, {
      headers: options.headers || {},
    });
    if (options.cookies) {
      for (const [name, value] of Object.entries(options.cookies)) {
        request.cookies.set(name, value);
      }
    }
    return request;
  }

  describe("Public paths", () => {
    it("should allow /login without token", async () => {
      const { proxy } = await import("@/proxy");
      const request = createProxyRequest("/login");
      const response = proxy(request);

      expect(response.status).not.toBe(401);
      expect(response.headers.get("Location")).toBeNull();
    });

    it("should allow /setup without token", async () => {
      const { proxy } = await import("@/proxy");
      const request = createProxyRequest("/setup");
      const response = proxy(request);

      expect(response.status).not.toBe(401);
    });

    it("should allow /api/auth without token", async () => {
      const { proxy } = await import("@/proxy");
      const request = createProxyRequest("/api/auth");
      const response = proxy(request);

      expect(response.status).not.toBe(401);
    });

    it("should allow /api/health without token", async () => {
      const { proxy } = await import("@/proxy");
      const request = createProxyRequest("/api/health");
      const response = proxy(request);

      expect(response.status).not.toBe(401);
    });

    it("should allow Twilio webhook paths without token", async () => {
      const { proxy } = await import("@/proxy");
      const request = createProxyRequest("/api/channels/phone/incoming");
      const response = proxy(request);

      expect(response.status).not.toBe(401);
    });
  });

  describe("Protected paths", () => {
    it("should return 401 for API routes without token", async () => {
      const { proxy } = await import("@/proxy");
      const request = createProxyRequest("/api/conversations");
      const response = proxy(request);

      expect(response.status).toBe(401);
    });

    it("should redirect pages to /login without token", async () => {
      const { proxy } = await import("@/proxy");
      const request = createProxyRequest("/conversations");
      const response = proxy(request);

      expect(response.status).toBe(307);
      expect(response.headers.get("Location")).toContain("/login");
    });

    it("should allow access with a validly-signed JWT", async () => {
      const { proxy } = await import("@/proxy");
      const validToken = jwt.sign(
        { userId: "admin-1", role: "admin" },
        "test-secret-key-for-testing-only",
        { expiresIn: "7d" }
      );
      const request = createProxyRequest("/api/conversations", {
        cookies: { "owly-token": validToken },
      });
      const response = proxy(request);

      expect(response.status).not.toBe(401);
    });

    it("should reject malformed token (not 3 parts)", async () => {
      const { proxy } = await import("@/proxy");
      const request = createProxyRequest("/api/conversations", {
        cookies: { "owly-token": "not-a-jwt" },
      });
      const response = proxy(request);

      expect(response.status).toBe(401);
    });

    it("should reject a structurally valid JWT with a tampered/wrong signature", async () => {
      const { proxy } = await import("@/proxy");
      // Three dot-separated parts, but signed with a secret the server doesn't know.
      const forgedToken = jwt.sign(
        { userId: "admin-1", role: "admin" },
        "attacker-controlled-secret",
        { expiresIn: "7d" }
      );
      const request = createProxyRequest("/api/conversations", {
        cookies: { "owly-token": forgedToken },
      });
      const response = proxy(request);

      expect(response.status).toBe(401);
    });

    it("should redirect a page request with a tampered signature to /login and clear the cookie", async () => {
      const { proxy } = await import("@/proxy");
      const forgedToken = jwt.sign(
        { userId: "admin-1", role: "admin" },
        "attacker-controlled-secret",
        { expiresIn: "7d" }
      );
      const request = createProxyRequest("/conversations", {
        cookies: { "owly-token": forgedToken },
      });
      const response = proxy(request);

      expect(response.status).toBe(307);
      expect(response.headers.get("Location")).toContain("/login");
      expect(response.cookies.get("owly-token")?.value).toBe("");
    });
  });

  describe("Security headers", () => {
    it("should include X-Content-Type-Options header", async () => {
      const { proxy } = await import("@/proxy");
      const request = createProxyRequest("/api/health");
      const response = proxy(request);

      expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    });

    it("should include X-Frame-Options header", async () => {
      const { proxy } = await import("@/proxy");
      const request = createProxyRequest("/api/health");
      const response = proxy(request);

      expect(response.headers.get("X-Frame-Options")).toBe("DENY");
    });

    it("should include X-XSS-Protection header", async () => {
      const { proxy } = await import("@/proxy");
      const request = createProxyRequest("/api/health");
      const response = proxy(request);

      expect(response.headers.get("X-XSS-Protection")).toBe("1; mode=block");
    });

    it("should include Referrer-Policy header", async () => {
      const { proxy } = await import("@/proxy");
      const request = createProxyRequest("/api/health");
      const response = proxy(request);

      expect(response.headers.get("Referrer-Policy")).toBe(
        "strict-origin-when-cross-origin"
      );
    });

    it("should include Permissions-Policy header", async () => {
      const { proxy } = await import("@/proxy");
      const request = createProxyRequest("/api/health");
      const response = proxy(request);

      expect(response.headers.get("Permissions-Policy")).toContain("camera=()");
    });
  });

  describe("Rate limiting", () => {
    it("should allow requests within auth rate limit", async () => {
      const { proxy } = await import("@/proxy");

      for (let i = 0; i < 5; i++) {
        const request = createProxyRequest("/api/auth", {
          headers: { "x-forwarded-for": "1.2.3.4" },
        });
        const response = proxy(request);
        expect(response.status).not.toBe(429);
      }
    });

    it("should block after exceeding auth rate limit", async () => {
      const { proxy } = await import("@/proxy");

      // Exhaust the rate limit
      for (let i = 0; i < 5; i++) {
        const request = createProxyRequest("/api/auth", {
          headers: { "x-forwarded-for": "10.0.0.1" },
        });
        proxy(request);
      }

      // 6th request should be blocked
      const request = createProxyRequest("/api/auth", {
        headers: { "x-forwarded-for": "10.0.0.1" },
      });
      const response = proxy(request);

      expect(response.status).toBe(429);
      expect(response.headers.get("Retry-After")).toBeDefined();
    });

    it("should track different IPs independently", async () => {
      const { proxy } = await import("@/proxy");

      // Exhaust rate limit for IP A
      for (let i = 0; i < 6; i++) {
        const request = createProxyRequest("/api/auth", {
          headers: { "x-forwarded-for": "192.168.1.1" },
        });
        proxy(request);
      }

      // IP B should still be allowed
      const request = createProxyRequest("/api/auth", {
        headers: { "x-forwarded-for": "192.168.1.2" },
      });
      const response = proxy(request);

      expect(response.status).not.toBe(429);
    });
  });

  describe("Static files", () => {
    it("should pass through _next paths", async () => {
      const { proxy } = await import("@/proxy");
      const request = createProxyRequest("/_next/static/chunk.js");
      const response = proxy(request);

      expect(response.status).toBe(200);
    });

    it("should pass through .png files", async () => {
      const { proxy } = await import("@/proxy");
      const request = createProxyRequest("/logo.png");
      const response = proxy(request);

      expect(response.status).toBe(200);
    });
  });
});
