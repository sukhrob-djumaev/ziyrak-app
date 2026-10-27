/**
 * Browser-side write helper (L3.1 / D05): a form closes and reports success only when the server accepted the write.
 * Every failure becomes a short message the person can act on; the form keeps what they typed.
 */
export type SubmitResult<T = unknown> = { ok: true; data: T } | { ok: false; status: number; message: string };

function messageFrom(status: number, body: unknown): string {
  // 401/403 bodies are generic ("Insufficient permissions"); the written copy tells the person what to do next.
  if (status === 401) return "You have been signed out. Sign in again, then retry; your entries are still here.";
  if (status === 403) return "Your role does not allow this change. Ask a workspace owner or admin.";
  const e = (body as { error?: unknown } | null)?.error;
  const detail = typeof e === "string" ? e : (e as { message?: unknown } | undefined)?.message;
  if (typeof detail === "string" && detail.trim()) return detail;
  if (status === 404) return "This item no longer exists. Reload the page.";
  if (status === 409) return "Someone else changed this at the same time. Reload and try again.";
  if (status === 429) return "Too many attempts. Wait a moment, then try again.";
  if (status >= 500) return "The server could not save this. Try again in a moment.";
  return "The change was not saved.";
}

export async function submitJson<T = unknown>(url: string, method: "POST" | "PUT" | "PATCH" | "DELETE", payload?: unknown): Promise<SubmitResult<T>> {
  try {
    const res = await fetch(url, {
      method,
      headers: payload === undefined ? undefined : { "Content-Type": "application/json" },
      body: payload === undefined ? undefined : JSON.stringify(payload),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) return { ok: false, status: res.status, message: messageFrom(res.status, body) };
    return { ok: true, data: body as T };
  } catch {
    return { ok: false, status: 0, message: "Could not reach the server. Check your connection and try again; your entries are still here." };
  }
}
