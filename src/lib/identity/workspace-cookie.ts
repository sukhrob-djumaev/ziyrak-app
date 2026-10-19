export const WORKSPACE_COOKIE = "ziyrak-workspace";
export function workspaceCookie(businessId: string) {
  return {
    name: WORKSPACE_COOKIE,
    value: businessId,
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    maxAge: 60 * 60 * 24 * 7,
    path: "/",
  };
}
export function clearWorkspaceCookie() {
  return { ...workspaceCookie(""), maxAge: 0 };
}
