import { NextResponse } from "next/server";
import {
  startEmailListener,
  stopEmailListener,
  getEmailStatus,
} from "@/lib/channels/email";

export async function GET() {
  const status = getEmailStatus();
  return NextResponse.json(status);
}

export async function POST(request: Request) {
  const body = await request.json();
  const { action } = body;

  if (action === "connect") {
    await startEmailListener();
    const status = getEmailStatus();
    return NextResponse.json(status);
  }

  if (action === "disconnect") {
    await stopEmailListener();
    return NextResponse.json({ status: "disconnected" });
  }

  return NextResponse.json({ error: "Invalid action" }, { status: 400 });
}
