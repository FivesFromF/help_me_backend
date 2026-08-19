import { PrismaClient } from "@prisma/client";
import dotenv from "dotenv";

dotenv.config();

const prisma = new PrismaClient();

async function main() {
  console.log("🌱 Seeding database...");

  // 1. Seed Admin
  const admin = await prisma.admin.upsert({
    where: { cognitoId: "test-admin-01" },
    create: {
      cognitoId: "test-admin-01",
      email: "admin@helpme.local",
      fullName: "HelpMe Administrator",
      avatarUrl: "https://api.dicebear.com/7.x/avataaars/svg?seed=Admin",
    },
    update: {
      fullName: "HelpMe Administrator",
      email: "admin@helpme.local",
    },
  });
  console.log(`✅ Admin seeded: ${admin.fullName} (${admin.cognitoId})`);

  // 2. Seed Staff (Emergency Medical Responder)
  const staff = await prisma.staff.upsert({
    where: { cognitoId: "test-staff-01" },
    create: {
      cognitoId: "test-staff-01",
      email: "doctor.tran@hospital.local",
      fullName: "Dr. Tran Minh",
      phone: "+84909123456",
      hospitalName: "Cho Ray Hospital",
      department: "Emergency Care",
      status: "active",
      avatarUrl: "https://api.dicebear.com/7.x/avataaars/svg?seed=Doctor",
    },
    update: {
      fullName: "Dr. Tran Minh",
      hospitalName: "Cho Ray Hospital",
      department: "Emergency Care",
    },
  });
  console.log(`✅ Staff seeded: ${staff.fullName} (${staff.hospitalName})`);

  // 3. Seed Citizen with Medical Record and NFC Tag
  const citizen = await prisma.citizen.upsert({
    where: { cognitoId: "test-citizen-01" },
    create: {
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
        {
          name: "Nguyen Thi Binh",
          phone: "+84909888999",
          relation: "Sister",
          email: "sister.binh@example.com",
        },
      ],
    },
    update: {
      fullName: "Nguyen Van An",
      phone: "+84901234567",
      isProfileUpdated: true,
      isVerified: true,
    },
  });
  console.log(`✅ Citizen seeded: ${citizen.fullName} (${citizen.id})`);

  // 4. Seed Medical Record for Citizen
  const medicalRecord = await prisma.medicalRecord.upsert({
    where: { citizenId: citizen.id },
    create: {
      citizenId: citizen.id,
      bloodGroup: "O+",
      distinguishingMarks: "Scar on right forearm",
      allergies: ["Penicillin", "Peanuts"],
      backgroundDiseases: ["Mild Asthma"],
      currentMedications: ["Albuterol Inhaler (as needed)"],
      notes: "Carries inhaler in personal bag",
    },
    update: {
      bloodGroup: "O+",
      allergies: ["Penicillin", "Peanuts"],
      backgroundDiseases: ["Mild Asthma"],
      currentMedications: ["Albuterol Inhaler (as needed)"],
    },
  });
  console.log(
    `✅ Medical record seeded for citizen ID: ${medicalRecord.citizenId}`,
  );

  // 5. Seed NFC Tag for Citizen
  const nfcTag = await prisma.nfcTag.upsert({
    where: { id: "NFC_DEMO_CARD_01" },
    create: {
      id: "NFC_DEMO_CARD_01",
      name: "Emergency Medical Bracelet",
      citizenId: citizen.id,
      status: "ACTIVE",
    },
    update: {
      name: "Emergency Medical Bracelet",
      citizenId: citizen.id,
      status: "ACTIVE",
    },
  });
  console.log(`✅ NFC tag seeded: ${nfcTag.id} -> Citizen ${citizen.fullName}`);

  console.log("🎉 Database seeding completed successfully!");
}

main()
  .catch((e) => {
    console.error("❌ Seeding failed:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
