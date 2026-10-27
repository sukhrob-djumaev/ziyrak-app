"use client";

import { useCallback } from "react";
import { useToast } from "@/components/ui/toast";
import type { SubmitResult } from "@/lib/http/submit-json";

type Accepted<T> = Extract<SubmitResult<T>, { ok: true }>;

/**
 * Turns the outcome of a `submitJson` write into either "go on" (true, narrowing the result) or a visible error (false).
 * A save that the server refused must never look like it worked.
 */
export function useReportWrite() {
  const { toast } = useToast();
  return useCallback(
    <T,>(action: string, result: SubmitResult<T>): result is Accepted<T> => {
      if (result.ok) return true;
      toast({ type: "error", title: `${action} failed`, description: result.message });
      return false;
    },
    [toast]
  );
}
