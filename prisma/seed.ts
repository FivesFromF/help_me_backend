import { PrismaClient } from "@prisma/client";
import dotenv from "dotenv";
import { generateHashId } from "../src/shared/services/hash.service";

dotenv.config();

const prisma = new PrismaClient();
const SYSTEM_SECRET = process.env.SYSTEM_SECRET || "helpme-secret-key";

/**
 * Seeds a demo dataset covering every state the app and the admin dashboard have to render.
 *
 * Idempotent throughout: fixed ids and upserts, so re-running updates rather than duplicating.
 * Rows that have no natural unique key (reports, QR codes) use hard-coded UUIDs for that reason.
 *
 * Deliberately includes the awkward states, not just the happy one - an unverified skeleton profile,
 * a lost card, a tag whose owner deleted it, an expired access session, and both flavours of
 * emergency report. Those are the cases that break UIs, and a seed that only produces perfect data
 * hides them until production does not.
 */

const HOUR = 60 * 60 * 1000;

// Fixed ids so reports and QR codes - which have no natural unique key - can be upserted.
//
// Note they only take effect on a FRESH database. Citizens are matched on `cognitoId`, so if a row
// with that cognitoId already exists the upsert takes its `update` branch and keeps whatever id it
// was originally given. Run against a reset database if you want these exact ids.
const IDS = {
  citizenAn: "11111111-1111-4111-8111-111111111111",
  citizenMai: "22222222-2222-4222-8222-222222222222",
  citizenKhoa: "33333333-3333-4333-8333-333333333333",
  qrAn: "aaaaaaaa-0000-4000-8000-000000000001",
  qrMai: "aaaaaaaa-0000-4000-8000-000000000002",
  reportIdentified: "bbbbbbbb-0000-4000-8000-000000000001",
  reportStandalone: "bbbbbbbb-0000-4000-8000-000000000002",
  reportResolved: "bbbbbbbb-0000-4000-8000-000000000003",
};

const RESPONDER = "test-responder-01";

async function main() {
  console.log("🌱 Seeding database...\n");

  // ── 1. Admin ────────────────────────────────────────────────────────────────
  const admin = await prisma.admin.upsert({
    where: { cognitoId: "test-admin-01" },
    create: {
      cognitoId: "test-admin-01",
      email: "admin@helpme.local",
      fullName: "HelpMe Administrator",
      avatarUrl: "https://api.dicebear.com/7.x/avataaars/svg?seed=Admin",
    },
    update: { fullName: "HelpMe Administrator", email: "admin@helpme.local" },
  });
  console.log(`✅ Admin              ${admin.fullName} (${admin.cognitoId})`);

  // ── 2. Citizens ─────────────────────────────────────────────────────────────
  // An: the complete case - profile, medical record, CCCD, biometrics, both card types.
  const an = await prisma.citizen.upsert({
    where: { cognitoId: "test-citizen-01" },
    create: {
      id: IDS.citizenAn,
      cognitoId: "test-citizen-01",
      email: "citizen.an@helpme.local",
      fullName: "Nguyen Van An",
      phone: "+84901234567",
      dateOfBirth: new Date("1995-05-15"),
      gender: "male",
      address: "123 Nguyen Hue, District 1, Ho Chi Minh City",
      cccdNumber: "079095012345",
      isProfileUpdated: true,
      isVerified: true,
      firstDeclareProfile: true,
      consentRegulation: true,
      emergencyContacts: [
        { name: "Nguyen Thi Binh", phone: "+84909888999", relation: "Sister", email: "sister.binh@example.com" },
      ],
    },
    update: { fullName: "Nguyen Van An", phone: "+84901234567", isProfileUpdated: true, isVerified: true },
  });

  // Mai: verified by CCCD only, no biometrics - proves `is_verified` and "has a face embedding"
  // are different things, which the admin dashboard must not conflate.
  const mai = await prisma.citizen.upsert({
    where: { cognitoId: "test-citizen-02" },
    create: {
      id: IDS.citizenMai,
      cognitoId: "test-citizen-02",
      email: "citizen.mai@helpme.local",
      fullName: "Tran Thi Mai",
      phone: "+84912345678",
      dateOfBirth: new Date("1988-11-02"),
      gender: "female",
      address: "45 Le Loi, Hai Chau, Da Nang",
      cccdNumber: "048188006789",
      isProfileUpdated: true,
      isVerified: true,
      firstDeclareProfile: true,
      consentRegulation: true,
      emergencyContacts: [
        { name: "Tran Van Hung", phone: "+84918777666", relation: "Husband", email: "hung.tran@example.com" },
      ],
    },
    update: { fullName: "Tran Thi Mai", isVerified: true },
  });

  // Khoa: the state just-in-time provisioning leaves behind - signed in, nothing filled in yet.
  // Every "profile incomplete" prompt in the app should be reachable with this row.
  const khoa = await prisma.citizen.upsert({
    where: { cognitoId: "test-citizen-03" },
    create: {
      id: IDS.citizenKhoa,
      cognitoId: "test-citizen-03",
      email: "citizen.khoa@helpme.local",
      fullName: "",
      isProfileUpdated: false,
      isVerified: false,
      consentRegulation: false,
    },
    update: { isProfileUpdated: false, isVerified: false },
  });
  console.log(`✅ Citizens           ${an.fullName} | ${mai.fullName} | (empty profile: ${khoa.cognitoId})`);

  // A 512-d embedding for An only. face_embedding is Unsupported("vector(512)") so Prisma cannot
  // write it; raw SQL is the only route. The values are arbitrary - nothing matches against them,
  // they exist so "has biometrics" filters and counters have something to find.
  const vector = `[${Array.from({ length: 512 }, (_, i) => (Math.sin(i) / 4).toFixed(6)).join(",")}]`;
  await prisma.$executeRawUnsafe(
    `UPDATE citizens SET face_embedding = $1::vector WHERE id = $2::uuid`,
    vector,
    an.id
  );
  console.log(`✅ Face embedding     512-d vector on ${an.fullName}`);

  // ── 3. Medical records ──────────────────────────────────────────────────────
  await prisma.medicalRecord.upsert({
    where: { citizenId: an.id },
    create: {
      citizenId: an.id,
      bloodGroup: "O+",
      distinguishingMarks: "Scar on right forearm",
      allergies: ["Penicillin", "Peanuts"],
      backgroundDiseases: ["Mild Asthma"],
      currentMedications: ["Albuterol Inhaler (as needed)"],
      notes: "Carries inhaler in personal bag",
    },
    update: { bloodGroup: "O+", allergies: ["Penicillin", "Peanuts"] },
  });

  await prisma.medicalRecord.upsert({
    where: { citizenId: mai.id },
    create: {
      citizenId: mai.id,
      bloodGroup: "A-",
      distinguishingMarks: "Tattoo of a lotus on left shoulder",
      allergies: ["Sulfa drugs"],
      backgroundDiseases: ["Type 2 Diabetes"],
      currentMedications: ["Metformin 500mg twice daily"],
      notes: "Diabetic - check blood sugar before administering glucose",
    },
    update: { bloodGroup: "A-" },
  });
  console.log(`✅ Medical records    2 (An: O+, Mai: A-)`);

  // ── 4. Cards: NFC tags and QR codes ─────────────────────────────────────────
  const tags = [
    { id: "NFC_DEMO_CARD_01", name: "Emergency Medical Bracelet", citizenId: an.id, status: "ACTIVE" },
    // Reported lost: still owned, but POST /api/scan refuses anything that is not ACTIVE.
    { id: "NFC_DEMO_CARD_02", name: "Keychain Tag (reported lost)", citizenId: mai.id, status: "LOST" },
    // Owner deleted this one: the hardware record survives with no citizen, ready to be re-issued.
    { id: "NFC_DEMO_CARD_03", name: "Unassigned stock tag", citizenId: null, status: "INACTIVE" },
  ];
  for (const t of tags) {
    await prisma.nfcTag.upsert({ where: { id: t.id }, create: t, update: t });
  }

  await prisma.qrCode.upsert({
    where: { id: IDS.qrAn },
    create: { id: IDS.qrAn, name: "Wallet card", citizenId: an.id, status: "ACTIVE" },
    update: { name: "Wallet card", status: "ACTIVE" },
  });
  await prisma.qrCode.upsert({
    where: { id: IDS.qrMai },
    create: { id: IDS.qrMai, name: "Helmet sticker", citizenId: mai.id, status: "ACTIVE" },
    update: { name: "Helmet sticker", status: "ACTIVE" },
  });
  console.log(`✅ Cards              3 NFC (ACTIVE / LOST / unassigned) + 2 QR`);

  // ── 5. Access sessions ──────────────────────────────────────────────────────
  // One live grant and one already elapsed. Expired rows are kept, not deleted - they are the
  // access history that emergency_reports.access_session_id points at.
  const liveSession = await prisma.accessSession.upsert({
    where: { responderId_victimId: { responderId: RESPONDER, victimId: an.id } },
    create: {
      responderId: RESPONDER,
      victimId: an.id,
      method: "NFC",
      expiresAt: new Date(Date.now() + 0.8 * HOUR),
      status: "ACTIVE",
    },
    update: { expiresAt: new Date(Date.now() + 0.8 * HOUR), status: "ACTIVE", method: "NFC" },
  });

  await prisma.accessSession.upsert({
    where: { responderId_victimId: { responderId: RESPONDER, victimId: mai.id } },
    create: {
      responderId: RESPONDER,
      victimId: mai.id,
      method: "QR",
      grantedAt: new Date(Date.now() - 26 * HOUR),
      expiresAt: new Date(Date.now() - 25 * HOUR),
      status: "EXPIRED",
    },
    update: { status: "EXPIRED", expiresAt: new Date(Date.now() - 25 * HOUR) },
  });
  console.log(`✅ Access sessions    1 ACTIVE (An) + 1 EXPIRED (Mai)`);

  // ── 6. Emergency reports ────────────────────────────────────────────────────
  // Identified: raised from the scan screen, so it carries the session that produced it.
  await prisma.emergencyReport.upsert({
    where: { id: IDS.reportIdentified },
    create: {
      id: IDS.reportIdentified,
      reporterId: RESPONDER,
      victimId: an.id,
      accessSessionId: liveSession.id,
      locationLat: "10.776889",
      locationLon: "106.700806",
      situationDescription: "Motorbike collision at Nguyen Hue, victim conscious but disoriented",
      status: "RESPONDING",
    },
    update: { status: "RESPONDING", accessSessionId: liveSession.id },
  });

  // Standalone: reported from the main screen with nobody identified.
  await prisma.emergencyReport.upsert({
    where: { id: IDS.reportStandalone },
    create: {
      id: IDS.reportStandalone,
      reporterId: an.id,
      victimId: null,
      accessSessionId: null,
      locationLat: "10.762622",
      locationLon: "106.660172",
      situationDescription: "Elderly person collapsed near the market, nobody knows them",
      status: "PENDING",
    },
    update: { status: "PENDING" },
  });

  await prisma.emergencyReport.upsert({
    where: { id: IDS.reportResolved },
    create: {
      id: IDS.reportResolved,
      reporterId: RESPONDER,
      victimId: mai.id,
      accessSessionId: null,
      locationLat: "16.047079",
      locationLon: "108.206230",
      situationDescription: "Hypoglycaemic episode, treated on scene",
      status: "RESOLVED",
    },
    update: { status: "RESOLVED" },
  });
  console.log(`✅ Emergency reports  3 (RESPONDING identified / PENDING standalone / RESOLVED)`);

  // ── Handy values for manual testing ─────────────────────────────────────────
  // hashId is derived from the citizen id and SYSTEM_SECRET, never stored - the scan path
  // recomputes and compares it, so these are what a physical card would carry.
  console.log("\n📋 Scan payloads (SYSTEM_SECRET-derived):");
  for (const c of [an, mai]) {
    const hashId = generateHashId(c.id, SYSTEM_SECRET);
    console.log(`   ${c.fullName}`);
    console.log(`     citizenId ${c.id}`);
    console.log(`     hashId    ${hashId}`);
  }
  console.log(`\n   NFC scan  { "method": "NFC", "tagId": "NFC_DEMO_CARD_01", "hashId": "<An hashId>" }`);
  console.log(`   QR scan   { "method": "QR",  "qrId": "${IDS.qrAn}", "hashId": "<An hashId>" }`);
  console.log(`   Headers   x-cognito-id: test-citizen-01 | x-role: citizen   (needs SKIP_AUTH=true)`);

  console.log("\n🎉 Database seeding completed successfully!");
}

main()
  .catch((e) => {
    console.error("❌ Seeding failed:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
