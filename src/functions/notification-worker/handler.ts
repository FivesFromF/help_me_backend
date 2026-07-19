import nodemailer from "nodemailer";
import { SNSClient, PublishCommand } from "@aws-sdk/client-sns";
import { db } from "../../db";
import { citizens } from "../../db/schema";
import { eq } from "drizzle-orm";

// Triggered by "victim.identified" on the emergency bus. Alerts the victim's
// emergency contacts on EVERY channel available on each contact:
//   - email    → SMTP (nodemailer)
//   - phone / backupPhone → SMS (AWS SNS)
// Contacts are stored as JSONB on citizens.emergency_contacts with the shape
// { name, relationship, phone, backupPhone, email } (see help_me_app ContactInfo).
// Previously we emailed only, so phone-only contacts (email === "") were never
// reached — the point of a next-of-kin alert. Now every reachable channel fires.

const SMTP_HOST = process.env.SMTP_HOST;
const SMTP_PORT = parseInt(process.env.SMTP_PORT || "587", 10);
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const SMTP_FROM = process.env.SMTP_FROM || SMTP_USER;

// Default country code for local-format phone numbers (Vietnam = 84).
const DEFAULT_CC = (process.env.SMS_DEFAULT_COUNTRY_CODE || "84").replace(/\D/g, "");

const sns = new SNSClient({});

// Normalize a stored phone number to E.164 (required by SNS). Handles VN local
// format ("0987…" → "+84987…"), bare country-code ("84987…" → "+84987…") and
// already-international ("+84…"). Returns null if there aren't enough digits.
function toE164(raw: string): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (trimmed.startsWith("+")) {
    const digits = trimmed.slice(1).replace(/\D/g, "");
    return digits.length >= 8 ? `+${digits}` : null;
  }
  let digits = trimmed.replace(/\D/g, "");
  if (!digits) return null;
  if (digits.startsWith("0")) {
    digits = DEFAULT_CC + digits.slice(1); // local → national
  } else if (!digits.startsWith(DEFAULT_CC)) {
    digits = DEFAULT_CC + digits; // assume local without leading 0
  }
  return digits.length >= 8 ? `+${digits}` : null;
}

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

  // Collect distinct recipients per channel across all contacts.
  const emails = new Set<string>();
  const phones = new Set<string>();
  for (const c of contacts) {
    if (typeof c?.email === "string" && c.email.trim().length > 0) {
      emails.add(c.email.trim());
    }
    for (const p of [c?.phone, c?.backupPhone]) {
      const e164 = typeof p === "string" ? toE164(p) : null;
      if (e164) phones.add(e164);
    }
  }

  if (emails.size === 0 && phones.size === 0) {
    console.warn(`[notify] no reachable emergency contacts for citizen ${victimId}; nothing sent`);
    return;
  }

  const when = detail.timestamp ?? new Date().toISOString();
  const who = victim.fullName || "Someone you are an emergency contact for";
  const method = detail.method || "an identification method";
  const bodyText =
    `This is an automated HelpMe emergency alert.\n\n` +
    `${who} was identified in an emergency situation via ${method} at ${when}.\n\n` +
    `Please try to reach them and contact local emergency services if needed.`;
  const smsText =
    `HelpMe alert: ${who} was identified in an emergency (${method}) at ${when}. ` +
    `Please reach them / call emergency services.`;

  const jobs: Promise<unknown>[] = [];

  // Email channel (SMTP)
  if (emails.size > 0) {
    if (SMTP_HOST) {
      const transporter = nodemailer.createTransport({
        host: SMTP_HOST,
        port: SMTP_PORT,
        secure: SMTP_PORT === 465,
        auth: SMTP_USER ? { user: SMTP_USER, pass: SMTP_PASS } : undefined,
      });
      for (const to of emails) {
        jobs.push(
          transporter
            .sendMail({ from: SMTP_FROM, to, subject: "HelpMe Emergency Alert", text: bodyText })
            .catch((err) => console.error(`[notify] failed to email ${to}:`, err))
        );
      }
    } else {
      console.error("[notify] SMTP_HOST not configured; skipping email channel");
    }
  }

  // SMS channel (SNS)
  for (const phone of phones) {
    jobs.push(
      sns
        .send(
          new PublishCommand({
            PhoneNumber: phone,
            Message: smsText,
            MessageAttributes: {
              "AWS.SNS.SMS.SMSType": { DataType: "String", StringValue: "Transactional" },
            },
          })
        )
        .catch((err) => console.error(`[notify] failed to SMS ${phone}:`, err))
    );
  }

  await Promise.all(jobs);
  console.log(
    `[notify] citizen ${victimId}: dispatched ${emails.size} email(s) + ${phones.size} SMS`
  );
};
