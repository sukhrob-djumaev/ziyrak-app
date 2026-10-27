"use client";

import { AlertCircle } from "lucide-react";

/** Shown instead of an empty list when loading failed, so "nothing here" is never confused with "could not load". */
export function LoadFailed({ what, onRetry }: { what: string; onRetry: () => void }) {
  return (
    <div role="alert" data-testid="load-failed" className="flex flex-col items-center gap-3 py-12 text-center">
      <AlertCircle className="h-8 w-8 text-ziyrak-danger" aria-hidden="true" />
      <p className="text-sm font-medium text-ziyrak-text">Could not load {what}.</p>
      <p className="text-xs text-ziyrak-text-light">Check your connection, then try again. Nothing was changed.</p>
      <button onClick={onRetry} className="px-3 py-1.5 text-sm font-medium rounded-lg border border-ziyrak-border text-ziyrak-text hover:bg-ziyrak-primary-50">
        Try again
      </button>
    </div>
  );
}
