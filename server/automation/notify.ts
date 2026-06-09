/**
 * Notifications (Phase 5). In-app always (persisted in `notifications`); email
 * optional via SMTP env (SMTP_URL + SMTP_FROM), off until configured.
 *
 * Email uses nodemailer ONLY if SMTP_URL is set — we lazy-import so the dep is not
 * required at boot and the app runs fine without email configured.
 */

import { storage } from "../storage";

export interface NotifyInput {
  title: string;
  body?: string;
  link?: string;
  kind?: "report_ready" | "job_failed" | "info";
  email?: string; // optional recipient; only sent if SMTP configured
}

export async function notify(input: NotifyInput): Promise<void> {
  // 1. Always record in-app.
  try {
    await storage.insertNotification({
      title: input.title,
      body: input.body ?? "",
      link: input.link ?? null,
      read: false,
      kind: input.kind ?? "info",
    });
  } catch (err) {
    console.error("[notify] in-app insert failed", err);
  }

  // 2. Optional email (only if SMTP configured AND a recipient is given).
  const smtpUrl = process.env.SMTP_URL;
  const from = process.env.SMTP_FROM;
  if (!smtpUrl || !from || !input.email) return;
  try {
    // Lazy import so nodemailer isn't required unless email is actually used.
    const nodemailer = await import("nodemailer").catch(() => null as any);
    if (!nodemailer) {
      console.warn("[notify] SMTP configured but nodemailer not installed; skipping email");
      return;
    }
    const transport = nodemailer.createTransport(smtpUrl);
    const linkLine = input.link ? `\n\n${input.link}` : "";
    await transport.sendMail({
      from,
      to: input.email,
      subject: input.title,
      text: `${input.body ?? ""}${linkLine}`,
    });
  } catch (err) {
    console.error("[notify] email send failed (non-fatal)", err);
  }
}
