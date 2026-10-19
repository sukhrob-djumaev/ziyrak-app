// Test setup records the workspace explicitly selected by each seeded identity.
// Requests can disable this fixture convenience when testing missing selection.
const selection = new Map<string, string>();
export function recordWorkspaceSelection(userId: string, businessId: string) {
  selection.set(userId, businessId);
}
export function workspaceSelectionForToken(token: string | undefined): string | undefined {
  if (!token) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString());
    return selection.get(payload.userId);
  } catch {
    return undefined;
  }
}
