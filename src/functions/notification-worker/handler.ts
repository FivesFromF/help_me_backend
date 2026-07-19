import nodemailer from "nodemailer";
import { db } from "../../db";
import { citizens } from "../../db/schema";
import { eq } from "drizzle-orm";

// Triggered by "victim.identified" on the emergency bus. Emails the victim's
// emergency contacts via SMTP. Contacts are stored as JSONB on
// citizens.emergency_contacts with the shape
// { name, relationship, phone, backupPhone, email }; we notify any contact that
// carries an `email`. SMTP auth uses SMTP_USER + SMTP_PASS (e.g. a Gmail app password).

const SMTP_HOST = process.env.SMTP_HOST;
const SMTP_PORT = parseInt(process.env.SMTP_PORT || "587", 10);
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const SMTP_FROM = process.env.SMTP_FROM || SMTP_USER;

export const main = async (event: any) => {
  const detail = event.detail ?? {};
  const victimId = detail.targetId ?? detail.victimId;
  if (!victimId) {
    console.warn("[notify] missing victimId; skipping");
    return;
  }

  const [victim] = await db.select().from(citizens).where(eq(citizens.id, victimId));
  if (!victim) {
    console.warn(`[notify] citizen ${victimId} not found`);
    return;
  }

  const contacts = Array.isArray(victim.emergencyContacts)
    ? (victim.emergencyContacts as any[])
    : [];

  // De-duplicate email recipients across all contacts.
  const recipients = [
    ...new Set(
      contacts
        .map((c) => (typeof c?.email === "string" ? c.email.trim() : ""))
        .filter((e) => e.length > 0)
    ),
  ];

  if (recipients.length === 0) {
    console.warn(`[notify] no emergency-contact emails for citizen ${victimId}; nothing sent`);
    return;
  }
  if (!SMTP_HOST) {
    console.error("[notify] SMTP_HOST not configured; cannot send");
    return;
  }

  const transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465,
    auth: SMTP_USER ? { user: SMTP_USER, pass: SMTP_PASS } : undefined,
  });

  const when = detail.timestamp ?? new Date().toISOString();
  const who = victim.fullName || "Someone you are an emergency contact for";
  const text =
    `This is an automated HelpMe emergency alert.\n\n` +
    `${who} was identified in an emergency situation via ` +
    `${detail.method || "an identification method"} at ${when}.\n\n` +
    `Please try to reach them and contact local emergency services if needed.`;

  await Promise.all(
    recipients.map((to) =>
      transporter
        .sendMail({ from: SMTP_FROM, to, subject: "HelpMe Emergency Alert", text })
        .catch((err) => console.error(`[notify] failed to email ${to}:`, err))
    )
  );

  console.log(`[notify] alerted ${recipients.length} contact(s) for citizen ${victimId}`);
};
