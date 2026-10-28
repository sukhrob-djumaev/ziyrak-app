import { NextResponse } from "next/server";
import { isEntitled } from "./entitlements";

/** For route handlers: null when the workspace's package includes the capability, else the 403 to return (after the permission check). */
export async function entitlementDenied(businessId: string, key: string): Promise<NextResponse | null> {
  if (await isEntitled(businessId, key)) return null;
  return NextResponse.json(
    { error: { code: "ENTITLEMENT_REQUIRED", message: "This workspace's current package does not include this feature.", capability: key } },
    { status: 403 }
  );
}
