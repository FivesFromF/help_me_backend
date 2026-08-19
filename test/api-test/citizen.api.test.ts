import { prisma } from "../../src/shared/db";
import { createWriteApp, createReadApp, performRequest, recordTest, TestResult } from "./test_helper";

export async function runCitizenApiTests(
  results: TestResult[],
  testCognitoId: string,
  testEmail: string,
  citizenId: string
) {
  console.log("\n👤 1. Testing Citizen Domain APIs (/api/citizen/...)");
  console.log("-".repeat(78));

  const writeApp = createWriteApp();
  const readApp = createReadApp();

  // 1.1 PUT /api/citizen/profile (Happy Path)
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
      "/api/citizen/profile",
      { "x-cognito-id": testCognitoId, "x-role": "citizen" },
      payload
    );
    recordTest(
      results,
      "Citizen API",
      "Update profile & accept consent regulation",
      "/api/citizen/profile",
      "PUT",
      200,
      res.status,
      res.status === 200 && res.body.profile?.consentRegulation === true
    );
  }

  // 1.2 PUT /api/citizen/profile (Unauthorized Rejection)
  {
    const res = await performRequest(
      writeApp,
      "PUT",
      "/api/citizen/profile",
      {},
      { fullName: "Hacker Name" }
    );
    recordTest(
      results,
      "Citizen API",
      "Reject unauthenticated profile update",
      "/api/citizen/profile",
      "PUT",
      401,
      res.status,
      res.status === 401
    );
  }

  // 1.3 PUT /api/citizen/medical-record (Happy Path)
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
      "/api/citizen/medical-record",
      { "x-cognito-id": testCognitoId, "x-role": "citizen" },
      payload
    );
    recordTest(
      results,
      "Citizen API",
      "Create / Update emergency medical record",
      "/api/citizen/medical-record",
      "PUT",
      200,
      res.status,
      res.status === 200 && res.body.record?.bloodGroup === "O+"
    );
  }

  // 1.4 POST /api/citizen/face (Validation: Missing Image)
  {
    const res = await performRequest(
      writeApp,
      "POST",
      "/api/citizen/face",
      { "x-cognito-id": testCognitoId, "x-role": "citizen" },
      {}
    );
    recordTest(
      results,
      "Citizen API",
      "Reject biometric registration without image",
      "/api/citizen/face",
      "POST",
      400,
      res.status,
      res.status === 400
    );
  }

  // 1.5 GET /api/citizen/profile (Happy Path)
  {
    const res = await performRequest(
      readApp,
      "GET",
      "/api/citizen/profile",
      { "x-cognito-id": testCognitoId, "x-role": "citizen" }
    );
    recordTest(
      results,
      "Citizen API",
      "Retrieve authenticated citizen demographic profile",
      "/api/citizen/profile",
      "GET",
      200,
      res.status,
      res.status === 200 && res.body.profile?.email === testEmail
    );
  }

  // 1.6 GET /api/citizen/medical-record (Happy Path)
  {
    const res = await performRequest(
      readApp,
      "GET",
      "/api/citizen/medical-record",
      { "x-cognito-id": testCognitoId, "x-role": "citizen" }
    );
    recordTest(
      results,
      "Citizen API",
      "Retrieve citizen emergency medical facts",
      "/api/citizen/medical-record",
      "GET",
      200,
      res.status,
      res.status === 200 && res.body.record?.bloodGroup === "O+"
    );
  }

  // 1.7 GET /api/citizen/nfc-tags (Happy Path)
  {
    const res = await performRequest(
      readApp,
      "GET",
      "/api/citizen/nfc-tags",
      { "x-cognito-id": testCognitoId, "x-role": "citizen" }
    );
    recordTest(
      results,
      "Citizen API",
      "List registered NFC hardware tags linked to citizen",
      "/api/citizen/nfc-tags",
      "GET",
      200,
      res.status,
      res.status === 200 && Array.isArray(res.body.tags)
    );
  }
}
