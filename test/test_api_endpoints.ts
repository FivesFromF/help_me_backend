import dotenv from "dotenv";
dotenv.config();

import express from "express";
import { writeRouter } from "../src/services/write-server/routes";
import { readRouter } from "../src/services/read-server/routes";
import { authenticate } from "../src/shared/middleware/auth";
import { prisma } from "../src/shared/db";
import { generateHashId } from "../src/shared/services/hash.service";

function createWriteApp() {
  const app = express();
  app.use(express.json({ limit: "10mb" }));
  app.use(authenticate);
  app.use(writeRouter);
  return app;
}

function createReadApp() {
  const app = express();
  app.use(express.json({ limit: "10mb" }));
  app.use(authenticate);
  app.use(readRouter);
  return app;
}

interface TestResult {
  suite: string;
  name: string;
  endpoint: string;
  method: string;
  expectedStatus: number;
  actualStatus: number;
  passed: boolean;
  details?: string;
}

const results: TestResult[] = [];

async function performRequest(
  app: express.Application,
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body?: any
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, async () => {
      const port = (server.address() as any).port;
      const url = `http://127.0.0.1:${port}${path}`;
      try {
        const fetchOptions: RequestInit = {
          method,
          headers: {
            "Content-Type": "application/json",
            ...headers,
          },
        };
        if (body && (method === "POST" || method === "PUT" || method === "PATCH")) {
          fetchOptions.body = JSON.stringify(body);
        }
        const res = await fetch(url, fetchOptions);
        const text = await res.text();
        let resBody: any = null;
        try {
          resBody = JSON.parse(text);
        } catch {
          resBody = text;
        }
        server.close(() => {
          resolve({ status: res.status, body: resBody });
        });
      } catch (err) {
        server.close(() => reject(err));
      }
    });
  });
}

function recordTest(
  suite: string,
  name: string,
  endpoint: string,
  method: string,
  expectedStatus: number,
  actualStatus: number,
  passed: boolean,
  details?: string
) {
  results.push({
    suite,
    name,
    endpoint,
    method,
    expectedStatus,
    actualStatus,
    passed,
    details,
  });
  const statusEmoji = passed ? "✅" : "❌";
  console.log(
    `  ${statusEmoji} [${method} ${endpoint}] ${name} -> Expected: ${expectedStatus}, Got: ${actualStatus}`
  );
  if (!passed && details) {
    console.log(`     ⚠️ Details: ${details}`);
  }
}

async function runAllApiTests() {
  console.log("\n" + "=".repeat(78));
  console.log("🧪  HelpMe Backend API Verification Test Suite (Write & Read Services)");
  console.log("=".repeat(78) + "\n");

  const writeApp = createWriteApp();
  const readApp = createReadApp();

  const testCognitoId = `cognito-test-${Date.now()}`;
  const testEmail = `api-test-${Date.now()}@helpme.local`;
  const systemSecret = process.env.SYSTEM_SECRET || "helpme-secret-key";
  const testTagId = `NFC_CARD_${Date.now()}`;

  // 0. Setup: Create initial citizen in DB for testing
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

  // ==========================================
  // SECTION 1: WRITE SERVER APIS
  // ==========================================
  console.log("📝 1. Testing Write Server APIs (Port 8080 Endpoints)");
  console.log("-".repeat(78));

  // 1.1 GET /health
  {
    const res = await performRequest(writeApp, "GET", "/health");
    recordTest(
      "Write Server",
      "Health check service status",
      "/health",
      "GET",
      200,
      res.status,
      res.status === 200 && res.body.status === "ok"
    );
  }

  // 1.2 PUT /api/v1/write/citizen/profile (Update Citizen Profile - Happy Path)
  {
    const payload = {
      fullName: "Pham Minh Duc (Updated)",
      phone: "+84988777999",
      address: "789 Tran Hung Dao, District 5, HCMC",
      cccdNumber: `CCCD_${Date.now()}`,
      gender: "MALE",
      dateOfBirth: "1994-04-12",
      firstDeclareProfile: true,
      consentRegulation: true,
      emergencyContacts: [
        { name: "Pham Van Father", phone: "+84911222333", relation: "Father" },
      ],
    };
    const res = await performRequest(
      writeApp,
      "PUT",
      "/api/v1/write/citizen/profile",
      { "x-cognito-id": testCognitoId, "x-role": "citizen" },
      payload
    );
    recordTest(
      "Write Server",
      "Update profile & accept regulation (Citizen Auth)",
      "/api/v1/write/citizen/profile",
      "PUT",
      200,
      res.status,
      res.status === 200 && res.body.profile?.consentRegulation === true
    );
  }

  // 1.3 PUT /api/v1/write/citizen/profile (Unauthorized Rejection)
  {
    const res = await performRequest(
      writeApp,
      "PUT",
      "/api/v1/write/citizen/profile",
      {},
      { fullName: "Hacker Name" }
    );
    recordTest(
      "Write Server",
      "Reject unauthenticated profile update",
      "/api/v1/write/citizen/profile",
      "PUT",
      401,
      res.status,
      res.status === 401
    );
  }

  // 1.4 PUT /api/v1/write/citizen/medical-record (Update Medical Record - Happy Path)
  {
    const payload = {
      bloodGroup: "O+",
      distinguishingMarks: "Small mole under right eye",
      allergies: ["Penicillin", "Dust Mites"],
      backgroundDiseases: ["Type 2 Diabetes"],
      currentMedications: ["Metformin 500mg"],
      notes: "Diabetic ID wristband in wallet",
    };
    const res = await performRequest(
      writeApp,
      "PUT",
      "/api/v1/write/citizen/medical-record",
      { "x-cognito-id": testCognitoId, "x-role": "citizen" },
      payload
    );
    recordTest(
      "Write Server",
      "Create / Update emergency medical record",
      "/api/v1/write/citizen/medical-record",
      "PUT",
      200,
      res.status,
      res.status === 200 && res.body.record?.bloodGroup === "O+"
    );
  }

  // 1.5 POST /api/v1/write/citizen/face (Validation: Missing imageBase64)
  {
    const res = await performRequest(
      writeApp,
      "POST",
      "/api/v1/write/citizen/face",
      { "x-cognito-id": testCognitoId, "x-role": "citizen" },
      {}
    );
    recordTest(
      "Write Server",
      "Reject biometric face registration without image payload",
      "/api/v1/write/citizen/face",
      "POST",
      400,
      res.status,
      res.status === 400
    );
  }

  // 1.6 POST /api/v1/write/nfc (Register NFC Tag - Happy Path)
  {
    const payload = {
      tagId: testTagId,
      name: "Emergency Medical NFC Band",
      citizenId: citizenId,
    };
    const res = await performRequest(
      writeApp,
      "POST",
      "/api/v1/write/nfc",
      { "x-cognito-id": testCognitoId, "x-role": "citizen" },
      payload
    );
    recordTest(
      "Write Server",
      "Register NFC card & calculate burnable Hash ID",
      "/api/v1/write/nfc",
      "POST",
      200,
      res.status,
      res.status === 200 && res.body.hashIdToBurn === validHashId
    );
  }

  // 1.7 POST /api/v1/write/nfc (Validation: Missing tagId)
  {
    const payload = { citizenId: citizenId };
    const res = await performRequest(
      writeApp,
      "POST",
      "/api/v1/write/nfc",
      { "x-cognito-id": testCognitoId, "x-role": "citizen" },
      payload
    );
    recordTest(
      "Write Server",
      "Reject NFC registration missing serial number (tagId)",
      "/api/v1/write/nfc",
      "POST",
      400,
      res.status,
      res.status === 400
    );
  }

  // 1.8 POST /api/v1/write/emergency/report (File Emergency Report - Happy Path)
  {
    const payload = {
      victimId: citizenId,
      locationLat: "10.7769",
      locationLon: "106.7009",
      situationDescription: "Motorbike accident, patient alert and breathing",
    };
    const res = await performRequest(
      writeApp,
      "POST",
      "/api/v1/write/emergency/report",
      { "x-cognito-id": "responder-01", "x-role": "admin" },
      payload
    );
    recordTest(
      "Write Server",
      "File incident emergency report with GPS coordinates",
      "/api/v1/write/emergency/report",
      "POST",
      201,
      res.status,
      res.status === 201 && !!res.body.report?.id
    );
  }

  // 1.9 POST /api/v1/write/emergency/report (Validation: Missing coordinates)
  {
    const res = await performRequest(
      writeApp,
      "POST",
      "/api/v1/write/emergency/report",
      { "x-cognito-id": "responder-01", "x-role": "admin" },
      { situationDescription: "Accident without GPS" }
    );
    recordTest(
      "Write Server",
      "Reject emergency report missing GPS coordinates",
      "/api/v1/write/emergency/report",
      "POST",
      400,
      res.status,
      res.status === 400
    );
  }

  // 1.10 POST /api/v1/write/upload-url (Generate Presigned S3 URL)
  {
    const payload = {
      fileType: "image/jpeg",
      operation: "FACE_SCAN",
      citizenId: citizenId,
    };
    const res = await performRequest(
      writeApp,
      "POST",
      "/api/v1/write/upload-url",
      { "x-cognito-id": "responder-01", "x-role": "admin" },
      payload
    );
    recordTest(
      "Write Server",
      "Generate presigned S3 URL for async biometric processing",
      "/api/v1/write/upload-url",
      "POST",
      200,
      res.status,
      res.status === 200 && !!res.body.jobId && !!res.body.uploadUrl
    );
  }

  // ==========================================
  // SECTION 2: READ SERVER APIS
  // ==========================================
  console.log("\n📖 2. Testing Read Server APIs (Port 8081 Endpoints)");
  console.log("-".repeat(78));

  // 2.1 GET /health
  {
    const res = await performRequest(readApp, "GET", "/health");
    recordTest(
      "Read Server",
      "Health check service status",
      "/health",
      "GET",
      200,
      res.status,
      res.status === 200 && res.body.status === "ok"
    );
  }

  // 2.2 GET /api/v1/read/citizen/profile (Get Citizen Profile - Happy Path)
  {
    const res = await performRequest(
      readApp,
      "GET",
      "/api/v1/read/citizen/profile",
      { "x-cognito-id": testCognitoId, "x-role": "citizen" }
    );
    recordTest(
      "Read Server",
      "Retrieve authenticated citizen demographic profile",
      "/api/v1/read/citizen/profile",
      "GET",
      200,
      res.status,
      res.status === 200 && res.body.profile?.email === testEmail
    );
  }

  // 2.3 GET /api/v1/read/citizen/medical-record (Get Medical Record - Happy Path)
  {
    const res = await performRequest(
      readApp,
      "GET",
      "/api/v1/read/citizen/medical-record",
      { "x-cognito-id": testCognitoId, "x-role": "citizen" }
    );
    recordTest(
      "Read Server",
      "Retrieve citizen emergency medical facts",
      "/api/v1/read/citizen/medical-record",
      "GET",
      200,
      res.status,
      res.status === 200 && res.body.record?.bloodGroup === "O+"
    );
  }

  // 2.4 GET /api/v1/read/citizen/nfc-tags (Get Citizen NFC Tags)
  {
    const res = await performRequest(
      readApp,
      "GET",
      "/api/v1/read/citizen/nfc-tags",
      { "x-cognito-id": testCognitoId, "x-role": "citizen" }
    );
    recordTest(
      "Read Server",
      "List registered NFC hardware tags linked to citizen",
      "/api/v1/read/citizen/nfc-tags",
      "GET",
      200,
      res.status,
      res.status === 200 && Array.isArray(res.body.tags) && res.body.tags.length > 0
    );
  }

  // 2.5 POST /api/v1/read/scan (NFC Emergency Scan - Happy Path)
  {
    const payload = {
      method: "NFC",
      tagId: testTagId,
      hashId: validHashId,
    };
    const res = await performRequest(
      readApp,
      "POST",
      "/api/v1/read/scan",
      { "x-cognito-id": "responder-medic-01", "x-role": "admin" },
      payload
    );
    recordTest(
      "Read Server",
      "Responder NFC scan resolves victim & medical profile",
      "/api/v1/read/scan",
      "POST",
      200,
      res.status,
      res.status === 200 && res.body.citizen?.id === citizenId && res.body.record?.bloodGroup === "O+"
    );
  }

  // 2.6 POST /api/v1/read/scan (Tampered Hash Rejection)
  {
    const payload = {
      method: "NFC",
      tagId: testTagId,
      hashId: "0000000000000000000000000000000000000000000000000000000000000000",
    };
    const res = await performRequest(
      readApp,
      "POST",
      "/api/v1/read/scan",
      { "x-cognito-id": "responder-medic-01", "x-role": "admin" },
      payload
    );
    recordTest(
      "Read Server",
      "Reject NFC scan with invalid / tampered hash ID",
      "/api/v1/read/scan",
      "POST",
      403,
      res.status,
      res.status === 403
    );
  }

  // 2.7 GET /api/v1/read/victim/:victimId (Re-access without active session)
  {
    const res = await performRequest(
      readApp,
      "GET",
      `/api/v1/read/victim/${citizenId}`,
      { "x-cognito-id": "stranger-responder-99", "x-role": "admin" }
    );
    recordTest(
      "Read Server",
      "Block unauthorized victim record re-access without active session",
      "/api/v1/read/victim/:victimId",
      "GET",
      403,
      res.status,
      res.status === 403
    );
  }

  // 2.8 GET /api/v1/read/scan/jobs/:jobId (Job Not Found)
  {
    const res = await performRequest(
      readApp,
      "GET",
      "/api/v1/read/scan/jobs/non-existent-job-12345",
      { "x-cognito-id": testCognitoId, "x-role": "citizen" }
    );
    recordTest(
      "Read Server",
      "Return 404 when querying non-existent scan job ID",
      "/api/v1/read/scan/jobs/:jobId",
      "GET",
      404,
      res.status,
      res.status === 404
    );
  }

  // Clean up test citizen
  await prisma.nfcTag.deleteMany({ where: { citizenId: citizenId } });
  await prisma.medicalRecord.deleteMany({ where: { citizenId: citizenId } });
  await prisma.emergencyReport.deleteMany({ where: { victimId: citizenId } });
  await prisma.citizen.delete({ where: { id: citizenId } });

  // ==========================================
  // SUMMARY REPORT
  // ==========================================
  console.log("\n" + "=".repeat(78));
  const passedCount = results.filter((r) => r.passed).length;
  const totalCount = results.length;
  console.log(`📊  Test Results: ${passedCount}/${totalCount} Passed (${Math.round((passedCount / totalCount) * 100)}%)`);
  console.log("=".repeat(78) + "\n");

  await prisma.$disconnect();

  if (passedCount !== totalCount) {
    process.exit(1);
  }
}

runAllApiTests().catch(async (err) => {
  console.error("❌ Fatal Test Error:", err);
  await prisma.$disconnect();
  process.exit(1);
});
