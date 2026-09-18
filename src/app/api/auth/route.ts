import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma/raw-client";
import {
  hashPassword,
  verifyPassword,
  generateToken,
  setAuthCookie,
  clearAuthCookie,
  getCurrentUser,
  isSetupComplete,
} from "@/lib/identity/auth";

// POST /api/auth - Login or Setup
export async function POST(request: NextRequest) {
  const body = await request.json();
  const { action, username, password, name } = body;

  if (action === "setup") {
    const setupDone = await isSetupComplete();
    if (setupDone) {
      return NextResponse.json(
        { error: "Setup already completed" },
        { status: 400 }
      );
    }

    if (!username || !password) {
      return NextResponse.json(
        { error: "Username and password are required" },
        { status: 400 }
      );
    }

    const hashed = await hashPassword(password);

    // PLAN.md §46.1/§46.2 — first-run bootstrap now creates the real
    // tenant shape directly (Business + TenantPlacement + User +
    // Membership("owner")) rather than a bare Admin row, so a brand-new
    // install ends up structurally identical to a migrated one (§46.1
    // task 14's seed.ts convention, applied here too).
    const business = await prisma.business.upsert({
      where: { slug: "default" },
      update: {},
      create: { slug: "default", name: "My Business", status: "active" },
    });

    await prisma.tenantPlacement.upsert({
      where: { businessId: business.id },
      update: {},
      create: { businessId: business.id },
    });

    const user = await prisma.user.create({
      data: { username, password: hashed, name: name || "Admin" },
    });

    await prisma.membership.create({
      data: { businessId: business.id, userId: user.id, role: "owner" },
    });

    await prisma.businessConfig.upsert({
      where: { businessId: business.id },
      update: {},
      create: { businessId: business.id },
    });

    for (const type of ["whatsapp", "email", "phone"]) {
      const existingConnection = await prisma.channelConnection.findFirst({
        where: { businessId: business.id, type },
      });
      if (!existingConnection) {
        await prisma.channelConnection.create({
          data: { businessId: business.id, type, name: type, isActive: false, status: "disconnected" },
        });
      }
    }

    const token = generateToken(user.id);
    const cookie = setAuthCookie(token);

    const response = NextResponse.json({
      success: true,
      user: { id: user.id, username: user.username, name: user.name },
    });
    response.cookies.set(cookie);
    return response;
  }

  if (action === "login") {
    if (!username || !password) {
      return NextResponse.json(
        { error: "Username and password are required" },
        { status: 400 }
      );
    }

    const user = await prisma.user.findUnique({ where: { username } });
    if (!user) {
      return NextResponse.json(
        { error: "Invalid credentials" },
        { status: 401 }
      );
    }

    const valid = await verifyPassword(password, user.password);
    if (!valid) {
      return NextResponse.json(
        { error: "Invalid credentials" },
        { status: 401 }
      );
    }

    const token = generateToken(user.id);
    const cookie = setAuthCookie(token);

    const response = NextResponse.json({
      success: true,
      user: { id: user.id, username: user.username, name: user.name },
    });
    response.cookies.set(cookie);
    return response;
  }

  if (action === "logout") {
    const cookie = clearAuthCookie();
    const response = NextResponse.json({ success: true });
    response.cookies.set(cookie);
    return response;
  }

  return NextResponse.json({ error: "Invalid action" }, { status: 400 });
}

// GET /api/auth - Check auth status
export async function GET() {
  const setupDone = await isSetupComplete();
  if (!setupDone) {
    return NextResponse.json({ authenticated: false, setupRequired: true });
  }

  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ authenticated: false, setupRequired: false });
  }

  return NextResponse.json({
    authenticated: true,
    setupRequired: false,
    user,
  });
}
