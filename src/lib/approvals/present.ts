/**
 * Display helpers for the approvals page (PLAN.md §23.4): turn an
 * `ActionExecution` row into text a supervisor can act on. Pure functions, so
 * the rules — above all, never showing a credential — are unit-tested.
 */

export function toolLabel(tool: string): string {
  const words = tool.trim().replace(/[_-]+/g, " ").trim();
  if (!words) return "Unknown action";
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** `requestedBy` is "ai", "system" or a user id; a user id is never shown raw. */
export function requesterLabel(requestedBy: string): string {
  if (requestedBy === "ai") return "AI assistant";
  if (requestedBy === "system") return "System";
  return "A teammate";
}

const SECRET_FIELD = /pass(word|wd)?|secret|token|api[-_]?key|auth|credential|private[-_]?key/i;
const REDACTED = "••••••";

export interface InputField {
  key: string;
  value: string;
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function render(value: unknown, max: number): string {
  if (typeof value === "string") return clip(value, max);
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return clip(JSON.stringify(value), max);
  return String(value);
}

/**
 * Top-level fields of an action's input as short strings. Values of fields
 * whose names look like credentials are replaced, so a tool that happens to
 * take an API key or password as an argument cannot leak it onto a screen.
 */
export function summarizeInput(input: unknown, maxLength = 120): InputField[] {
  if (input === null || input === undefined) return [];
  if (typeof input !== "object" || Array.isArray(input)) return [{ key: "input", value: render(input, maxLength) }];
  return Object.entries(input as Record<string, unknown>).map(([key, value]) => ({
    key,
    value: SECRET_FIELD.test(key) ? REDACTED : render(value, maxLength),
  }));
}

export type StatusVariant = "default" | "success" | "warning" | "danger" | "info";

export function statusPresentation(status: string): { label: string; variant: StatusVariant } {
  switch (status) {
    case "pending_approval":
      return { label: "Waiting for approval", variant: "warning" };
    case "requested":
    case "scheduled":
    case "running":
      return { label: status === "scheduled" ? "Scheduled" : "In progress", variant: "info" };
    case "succeeded":
      return { label: "Done", variant: "success" };
    case "failed":
      return { label: "Failed", variant: "danger" };
    case "cancelled":
      return { label: "Rejected", variant: "default" };
    default:
      return { label: status, variant: "default" };
  }
}

export function timeAgo(timestamp: string, now: Date = new Date()): string {
  const then = new Date(timestamp).getTime();
  if (Number.isNaN(then)) return "";
  const seconds = Math.max(0, Math.floor((now.getTime() - then) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} d ago`;
}
