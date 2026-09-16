import { describe, it, expect } from "vitest";
import { matchesSegment } from "@/lib/campaigns";

describe("Campaign Segmentation", () => {
  describe("matchesSegment", () => {
    const customer = {
      name: "John Doe",
      email: "john@example.com",
      tags: "vip,premium",
      lastContact: "2026-01-15T00:00:00Z",
    };

    it("should match equals operator", () => {
      expect(matchesSegment(customer, { field: "email", operator: "equals", value: "john@example.com" })).toBe(true);
    });

    it("should match contains operator", () => {
      expect(matchesSegment(customer, { field: "tags", operator: "contains", value: "vip" })).toBe(true);
    });

    it("should match starts_with operator", () => {
      expect(matchesSegment(customer, { field: "name", operator: "starts_with", value: "John" })).toBe(true);
    });

    it("should match not_contains operator", () => {
      expect(matchesSegment(customer, { field: "tags", operator: "not_contains", value: "banned" })).toBe(true);
    });

    it("should match is_empty operator", () => {
      expect(matchesSegment({ notes: "" }, { field: "notes", operator: "is_empty", value: "" })).toBe(true);
    });

    it("should match is_not_empty operator", () => {
      expect(matchesSegment(customer, { field: "email", operator: "is_not_empty", value: "" })).toBe(true);
    });

    it("should not match when value differs", () => {
      expect(matchesSegment(customer, { field: "email", operator: "equals", value: "other@example.com" })).toBe(false);
    });

    it("should be case insensitive", () => {
      expect(matchesSegment(customer, { field: "name", operator: "contains", value: "JOHN" })).toBe(true);
    });
  });
});
