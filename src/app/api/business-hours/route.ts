import { NextRequest, NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import { requireAuth, isAuthenticated } from "@/lib/route-auth";
import { toErrorResponse } from "@/lib/errors";
import * as businessHoursService from "@/lib/business-hours/service";

export async function GET(request: NextRequest) {
  const ctx = await requireAuth(request, "business-hours:read");
  if (!isAuthenticated(ctx)) return ctx;

  try {
    const config = await businessHoursService.get(ctx);
    return NextResponse.json(config);
  } catch (error) {
    logger.error("Failed to fetch business hours:", error);
    return toErrorResponse(error);
  }
}

export async function PUT(request: NextRequest) {
  const ctx = await requireAuth(request, "business-hours:update");
  if (!isAuthenticated(ctx)) return ctx;

  try {
    const body = await request.json();
    const {
      enabled,
      timezone,
      monday,
      tuesday,
      wednesday,
      thursday,
      friday,
      saturday,
      sunday,
      offlineMessage,
    } = body;

    const timePattern = /^\d{2}:\d{2}-\d{2}:\d{2}$/;
    const days = { monday, tuesday, wednesday, thursday, friday, saturday, sunday };

    for (const [day, value] of Object.entries(days)) {
      if (value !== undefined && value !== "" && !timePattern.test(value as string)) {
        return NextResponse.json(
          { error: `Invalid time format for ${day}. Use HH:mm-HH:mm or leave empty.` },
          { status: 400 }
        );
      }
    }

    const config = await businessHoursService.upsert(ctx, {
      enabled,
      timezone,
      monday,
      tuesday,
      wednesday,
      thursday,
      friday,
      saturday,
      sunday,
      offlineMessage,
    });

    return NextResponse.json(config);
  } catch (error) {
    logger.error("Failed to update business hours:", error);
    return toErrorResponse(error);
  }
}
