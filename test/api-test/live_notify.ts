import dotenv from "dotenv";
dotenv.config();

import nodemailer from "nodemailer";
import { prisma } from "../../src/shared/db";

/**
 * Opt-in live check of the real alert path — it sends an actual email through whatever
 * SMTP_HOST `.env` points at.
 *
 * Deliberately NOT part of `npm run test:api`. The suite must stay safe to run anywhere,
 * on any branch, by anyone; this one costs a real message and is therefore explicit:
 *
 *   npm run test:notify -- you@example.com
 *
 * It refuses to run without a recipient on the command line. There is no default: the whole
 * point of an emergency alert is that it reaches a real person, so picking one implicitly is
 * exactly the mistake to avoid.
 *
 * What it proves, in order:
 *   1. the configured SMTP transport accepts our credentials  (transporter.verify)
 *   2. notification-worker resolves the victim, finds the contact, and sends  (real handler)
 */

const recipient = process.argv[2] || process.env.TEST_ALERT_TO || "";

function fail(msg: string): never {
  console.error(`\n❌ ${msg}\n`);
  process.exit(1);
}

async function main() {
  console.log("\n" + "=".repeat(78));
  console.log("✉️   HelpMe Live Notification Check (sends a REAL email)");
  console.log("=".repeat(78));

  if (!recipient || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(recipient)) {
    fail(
      "No recipient. Run: npm run test:notify -- you@example.com\n" +
        "   (this sends a real email, so the address must be given explicitly)"
    );
  }
  if (!process.env.SMTP_HOST) fail("SMTP_HOST is not set in .env");

  console.log(`\n  Host:      ${process.env.SMTP_HOST}:${process.env.SMTP_PORT || 587}`);
  console.log(`  Recipient: ${recipient}`);

  // ── 1. Does the configured transport actually accept us? ────────────────────
  const port = parseInt(process.env.SMTP_PORT || "587", 10);
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure: port === 465,
    auth: process.env.SMTP_USER
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
      : undefined,
  });

  try {
    await transporter.verify();
    console.log("\n  ✅ SMTP transport verified (credentials accepted)");
  } catch (err: any) {
    fail(`SMTP verify failed: ${err?.message || err}`);
  }

  // ── 2. Drive the real worker, end to end ────────────────────────────────────
  // A throwaway citizen carrying the recipient as next-of-kin, so the handler takes the
  // same path it would in a real emergency: look up victim → read emergencyContacts → send.
  const citizen = await prisma.citizen.create({
    data: {
      cognitoId: `live-notify-${Date.now()}`,
      email: `live-notify-${Date.now()}@helpme.local`,
      fullName: "Live Notification Probe",
      phone: "+84900000000",
      emergencyContacts: [{ name: "Live Test Recipient", email: recipient, phone: "+84900000001" }],
      isProfileUpdated: true,
      isVerified: true,
      consentRegulation: true,
    },
  });

  // The handler swallows per-recipient send errors, so watch stderr to tell a real send
  // from a silent failure.
  const originalError = console.error;
  let sendFailed: string | null = null;
  console.error = (...args: any[]) => {
    const text = args.map(String).join(" ");
    if (text.includes("[notify]")) sendFailed = text;
    originalError(...args);
  };

  try {
    const { main: notifyMain } = await import("../../src/functions/notification-worker/handler");
    await notifyMain({
      id: `live-${Date.now()}`,
      source: "helpme.backend",
      "detail-type": "victim.identified",
      time: new Date().toISOString(),
      detail: { targetId: citizen.id, responderId: "live-check-responder", method: "NFC" },
    });
  } finally {
    console.error = originalError;
    await prisma.citizen.delete({ where: { id: citizen.id } });
    await prisma.$disconnect();
  }

  if (sendFailed) fail(`notification-worker reported: ${sendFailed}`);

  console.log(`  ✅ notification-worker sent the alert to ${recipient}`);
  console.log("\n" + "=".repeat(78));
  console.log("  Check that inbox for “HelpMe Emergency Alert”. Nothing was left in the DB.");
  console.log("=".repeat(78) + "\n");
}

main().catch(async (err) => {
  console.error("❌ Live notification check failed:", err);
  await prisma.$disconnect();
  process.exit(1);
});
