import dotenv from "dotenv";
dotenv.config();

import { prisma } from "../../src/shared/db";
import { generateHashId } from "../../src/shared/services/hash.service";
import { TestResult, createWriteApp, createReadApp, performRequest, recordTest } from "./test_helper";
import { runCitizenApiTests } from "./citizen.api.test";
import { runNfcScanApiTests } from "./nfc_scan.api.test";
import { runEmergencyApiTests } from "./emergency.api.test";
import { runRegistrationApiTests } from "./registration.api.test";

async function runAllGroupedApiTests() {
  console.log("\n" + "=".repeat(78));
  console.log("🧪  HelpMe API Comprehensive Test Runner (Grouped /api Modules)");
  console.log("=".repeat(78));

  const results: TestResult[] = [];
  const testCognitoId = `cognito-test-${Date.now()}`;
  const testEmail = `api-test-${Date.now()}@helpme.local`;
  const systemSecret = process.env.SYSTEM_SECRET || "helpme-secret-key";
  const testTagId = `NFC_CARD_${Date.now()}`;

  // 0. Setup: Create initial test citizen in DB
  const seedCitizen = await prisma.citizen.create({
    data: {
      cognitoId: testCognitoId,
      email: testEmail,
      fullName: "Pham Minh Duc",
      phone: "+84988777666",
      isProfileUpdated: false,
      isVerified: false,
      consentRegulation: false,
    },
  });
  const citizenId = seedCitizen.id;
  const validHashId = generateHashId(citizenId, systemSecret);

  // 1. Health Checks
  console.log("\n🏥 0. Testing Service Health Liveness (/health)");
  console.log("-".repeat(78));
  const writeApp = createWriteApp();
  const readApp = createReadApp();

  const writeHealth = await performRequest(writeApp, "GET", "/health");
  recordTest(
    results,
    "Health",
    "Write service health probe",
    "/health",
    "GET",
    200,
    writeHealth.status,
    writeHealth.status === 200 && writeHealth.body.status === "ok"
  );

  const readHealth = await performRequest(readApp, "GET", "/health");
  recordTest(
    results,
    "Health",
    "Read service health probe",
    "/health",
    "GET",
    200,
    readHealth.status,
    readHealth.status === 200 && readHealth.body.status === "ok"
  );

  // 2. Run Grouped Test Suites
  await runCitizenApiTests(results, testCognitoId, testEmail, citizenId);
  await runNfcScanApiTests(results, testCognitoId, citizenId, testTagId, validHashId);
  await runEmergencyApiTests(results, citizenId, testCognitoId);
  await runRegistrationApiTests(results);

  // 3. Teardown
  await prisma.nfcTag.deleteMany({ where: { citizenId: citizenId } });
  await prisma.medicalRecord.deleteMany({ where: { citizenId: citizenId } });
  await prisma.emergencyReport.deleteMany({ where: { victimId: citizenId } });
  await prisma.citizen.delete({ where: { id: citizenId } });
  await prisma.$disconnect();

  // 4. Consolidated Summary
  console.log("\n" + "=".repeat(78));
  const passedCount = results.filter((r) => r.passed).length;
  const totalCount = results.length;
  console.log(`📊  Grouped API Test Results: ${passedCount}/${totalCount} Passed (${Math.round((passedCount / totalCount) * 100)}%)`);
  console.log("=".repeat(78) + "\n");

  if (passedCount !== totalCount) {
    process.exit(1);
  }
}

runAllGroupedApiTests().catch(async (err) => {
  console.error("❌ Fatal Test Error:", err);
  await prisma.$disconnect();
  process.exit(1);
});
