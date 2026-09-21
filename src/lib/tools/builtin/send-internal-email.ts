import { z } from "zod";
import nodemailer from "nodemailer";
import { prisma } from "@/lib/prisma/raw-client";
import type { ToolDefinition } from "../types";

const schema = z.object({
  to: z.string().describe("Email address of the team member"),
  subject: z.string().describe("Email subject"),
  body: z.string().describe("Email body content"),
});

/** PLAN.md §23.2 — mechanical extraction of `tools.ts`'s `sendInternalEmail()` branch; logic unchanged. */
export const sendInternalEmailTool: ToolDefinition = {
  name: "send_internal_email",
  description: "Send an email to a team member about a customer issue that needs their attention.",
  schema,
  async execute(_ctx, args) {
    const { to, subject, body } = schema.parse(args);
    const settings = await prisma.settings.findFirst();
    if (!settings?.smtpHost) {
      return {
        success: false,
        status: "failed",
        message: "Email not configured. Please set up SMTP in settings.",
      };
    }

    const transporter = nodemailer.createTransport({
      host: settings.smtpHost,
      port: settings.smtpPort,
      secure: settings.smtpPort === 465,
      auth: { user: settings.smtpUser, pass: settings.smtpPass },
    });

    await transporter.sendMail({
      from: settings.smtpFrom || settings.smtpUser,
      to,
      subject,
      text: body,
    });

    return { success: true, status: "succeeded", message: `Email sent to ${to}` };
  },
};
