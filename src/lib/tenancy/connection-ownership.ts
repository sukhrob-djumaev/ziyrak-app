type ConversationOwner = { channel?: unknown; metadata?: unknown };
function connectionId(row: ConversationOwner) {
  const metadata =
    row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata)
      ? (row.metadata as Record<string, unknown>)
      : {};
  return metadata.channelConnectionId;
}
/** Moving related data never changes the external connection that owns it. */
export function sameConnectionOwner(
  a: ConversationOwner,
  b: ConversationOwner,
  allowLegacyApi = false
) {
  if (typeof a.channel !== "string" || a.channel !== b.channel) return false;
  const first = connectionId(a),
    second = connectionId(b);
  if (typeof first === "string" && first && first === second) return true;
  return allowLegacyApi && a.channel === "api" && first === undefined && second === undefined;
}
