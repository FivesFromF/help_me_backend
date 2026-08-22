import nodemailer from "nodemailer";

const SMTP_HOST = process.env.SMTP_HOST;
const SMTP_PORT = parseInt(process.env.SMTP_PORT || "587", 10);
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const SMTP_FROM = process.env.SMTP_FROM || SMTP_USER;

export const main = async (event: any) => {
  const detail = event.detail ?? {};
  const victimId = detail.targetId ?? detail.victimId;

  // Đọc thẳng từ sự kiện thay vì truy vấn Postgres. Publisher (scan.routes.ts và worker.py) đã có
  // sẵn hàng citizen trong tay khi phát sự kiện, nên nó đính kèm luôn. Nhờ vậy Lambda này không
  // cần DATABASE_URL, không cần vào VPC, và không cần NAT gateway để vừa gọi được SMTP vừa gọi RDS.
  // Sự kiện cũng trở thành bản ghi tự chứa về một thời điểm, thay vì con trỏ phải tra cứu lại sau.
  const victim: any = detail.victim ?? null;

  if (!victim) {
    console.warn(
      `[notify] event for '${victimId}' carries no victim payload; publisher must include detail.victim`
    );
  }

  if (!victim) {
    console.warn(`[notify] citizen '${victimId}' not found in database; skipping alert email`);
    return;
  }

  const contacts = Array.isArray(victim.emergencyContacts)
    ? (victim.emergencyContacts as any[])
    : [];

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
