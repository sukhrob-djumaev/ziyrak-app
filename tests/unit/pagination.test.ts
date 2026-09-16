import { describe, it, expect } from "vitest";
import { parsePagination, paginatedResponse } from "@/lib/pagination";

describe("Pagination Helper", () => {
  describe("parsePagination", () => {
    it("should return defaults when no params provided", () => {
      const params = new URLSearchParams();
      const result = parsePagination(params);

      expect(result.page).toBe(1);
      expect(result.limit).toBe(20);
      expect(result.skip).toBe(0);
      expect(result.take).toBe(20);
    });

    it("should parse page and limit from params", () => {
      const params = new URLSearchParams({ page: "3", limit: "50" });
      const result = parsePagination(params);

      expect(result.page).toBe(3);
      expect(result.limit).toBe(50);
      expect(result.skip).toBe(100);
      expect(result.take).toBe(50);
    });

    it("should cap limit at 100", () => {
      const params = new URLSearchParams({ limit: "500" });
      const result = parsePagination(params);

      expect(result.limit).toBe(100);
      expect(result.take).toBe(100);
    });

    it("should enforce minimum page of 1", () => {
      const params = new URLSearchParams({ page: "0" });
      const result = parsePagination(params);

      expect(result.page).toBe(1);
      expect(result.skip).toBe(0);
    });

    it("should enforce minimum limit of 1", () => {
      const params = new URLSearchParams({ limit: "-5" });
      const result = parsePagination(params);

      expect(result.limit).toBe(1);
    });

    it("should handle non-numeric values gracefully", () => {
      const params = new URLSearchParams({ page: "abc", limit: "xyz" });
      const result = parsePagination(params);

      expect(result.page).toBe(1);
      expect(result.limit).toBe(20);
    });

    it("should calculate correct skip for page 5 limit 10", () => {
      const params = new URLSearchParams({ page: "5", limit: "10" });
      const result = parsePagination(params);

      expect(result.skip).toBe(40);
    });
  });

  describe("paginatedResponse", () => {
    it("should return correct pagination metadata", () => {
      const data = [{ id: 1 }, { id: 2 }];
      const result = paginatedResponse(data, 50, 1, 20);

      expect(result.data).toEqual(data);
      expect(result.pagination.page).toBe(1);
      expect(result.pagination.limit).toBe(20);
      expect(result.pagination.total).toBe(50);
      expect(result.pagination.totalPages).toBe(3);
    });

    it("should calculate totalPages correctly for exact division", () => {
      const result = paginatedResponse([], 100, 1, 20);
      expect(result.pagination.totalPages).toBe(5);
    });

    it("should calculate totalPages correctly for remainder", () => {
      const result = paginatedResponse([], 101, 1, 20);
      expect(result.pagination.totalPages).toBe(6);
    });

    it("should handle empty data", () => {
      const result = paginatedResponse([], 0, 1, 20);

      expect(result.data).toEqual([]);
      expect(result.pagination.total).toBe(0);
      expect(result.pagination.totalPages).toBe(0);
    });
  });
});
