import { prisma } from "../../src/shared/db";
import { createWriteApp, createReadApp, performRequest, recordTest, TestResult } from "./test_helper";

const SUITE = "Registration";
const PROFILE = "/api/citizen/profile";

/**
 * Citizen information registration (first profile declaration).
 *
 * There is no /user/register HTTP route — Cognito's post-confirmation trigger creates the
 * skeleton citizen row, and the citizen then *declares their information* through
 * PUT /api/citizen/profile. That declaration is what these cases cover.
 *
 * This suite seeds and tears down its own citizen so the consent cases start from
 * consentRegulation = false regardless of what the other suites did.
 */
export async function runRegistrationApiTests(results: TestResult[]) {
  console.log("\n📝 4. Testing Citizen Information Registration (/api/citizen/profile)");
  console.log("-".repeat(78));

  const writeApp = createWriteApp();
  const readApp = createReadApp();

  const cognitoId = `cognito-reg-${Date.now()}`;
  const email = `reg-test-${Date.now()}@helpme.local`;
  const unknownCognitoId = `cognito-ghost-${Date.now()}`;

  // Skeleton row exactly as the post-confirmation trigger would leave it.
  const seeded = await prisma.citizen.create({
    data: {
      cognitoId,
      email,
      fullName: "",
      isProfileUpdated: false,
      isVerified: false,
      firstDeclareProfile: false,
      consentRegulation: false,
    },
  });

  const citizenHeaders = { "x-cognito-id": cognitoId, "x-role": "citizen" };

  try {
    // ── R-01: First declaration persists every submitted field ──────────────────
    const cccdNumber = `CCCD_REG_${Date.now()}`;
    {
      const payload = {
        fullName: "Nguyen Thi Lan",
        phone: "+84912345678",
        address: "12 Le Loi, District 1, HCMC",
        cccdNumber,
        gender: "FEMALE",
        dateOfBirth: "1996-09-23",
        firstDeclareProfile: true,
        consentRegulation: true,
        emergencyContacts: [
          { name: "Nguyen Van Minh", phone: "+84909111222", relation: "Husband" },
          { name: "Nguyen Thi Hoa", phone: "+84909333444", relation: "Mother" },
        ],
      };

      const res = await performRequest(writeApp, "PUT", PROFILE, citizenHeaders, payload);

      // Verify the row itself, not just the echoed response.
      const row = await prisma.citizen.findUnique({ where: { cognitoId } });
      const contacts = (row?.emergencyContacts as any[]) || [];

      const mismatches: string[] = [];
      if (row?.fullName !== payload.fullName) mismatches.push(`fullName=${row?.fullName}`);
      if (row?.phone !== payload.phone) mismatches.push(`phone=${row?.phone}`);
      if (row?.address !== payload.address) mismatches.push(`address=${row?.address}`);
      if (row?.cccdNumber !== payload.cccdNumber) mismatches.push(`cccdNumber=${row?.cccdNumber}`);
      if (row?.gender !== payload.gender) mismatches.push(`gender=${row?.gender}`);
      if (row?.dateOfBirth?.toISOString().slice(0, 10) !== payload.dateOfBirth)
        mismatches.push(`dateOfBirth=${row?.dateOfBirth?.toISOString()}`);
      if (row?.isProfileUpdated !== true) mismatches.push(`isProfileUpdated=${row?.isProfileUpdated}`);
      if (row?.firstDeclareProfile !== true) mismatches.push(`firstDeclareProfile=${row?.firstDeclareProfile}`);
      if (row?.consentRegulation !== true) mismatches.push(`consentRegulation=${row?.consentRegulation}`);
      if (contacts.length !== 2) mismatches.push(`emergencyContacts.length=${contacts.length}`);
      else if (contacts[0]?.relation !== "Husband") mismatches.push(`contact[0].relation=${contacts[0]?.relation}`);

      recordTest(
        results,
        SUITE,
        "First declaration persists all submitted fields",
        PROFILE,
        "PUT",
        200,
        res.status,
        res.status === 200 && mismatches.length === 0,
        mismatches.length ? `Field mismatches: ${mismatches.join(", ")}` : undefined
      );
    }

    // ── R-02: Registered information reads back over the read service ───────────
    {
      const res = await performRequest(readApp, "GET", PROFILE, citizenHeaders);
      const p = res.body?.profile;
      const ok =
        res.status === 200 &&
        p?.fullName === "Nguyen Thi Lan" &&
        p?.cccdNumber === cccdNumber &&
        p?.email === email &&
        Array.isArray(p?.emergencyContacts) &&
        p.emergencyContacts.length === 2;

      recordTest(
        results,
        SUITE,
        "Registered information reads back via read service",
        PROFILE,
        "GET",
        200,
        res.status,
        ok,
        ok ? undefined : `Read-back mismatch: ${JSON.stringify(p)?.slice(0, 200)}`
      );
    }

    // ── R-03: Consent must survive a later partial edit ─────────────────────────
    // Registration is also the consent record, so a later edit that says nothing about
    // consent must not rewrite it. Reset to false, then send a phone-only update.
    {
      await prisma.citizen.update({ where: { cognitoId }, data: { consentRegulation: false } });

      const res = await performRequest(writeApp, "PUT", PROFILE, citizenHeaders, {
        phone: "+84900000111",
      });
      const row = await prisma.citizen.findUnique({ where: { cognitoId } });

      recordTest(
        results,
        SUITE,
        "Partial edit must not silently grant consent",
        PROFILE,
        "PUT",
        200,
        res.status,
        res.status === 200 && row?.consentRegulation === false,
        row?.consentRegulation === true
          ? "consentRegulation flipped false → true although the request never mentioned consent " +
            "(citizen.routes.ts:30 `body.consentRegulation ?? true`)"
          : undefined
      );
    }

    // ── R-04: Explicit consent withdrawal is honoured ───────────────────────────
    {
      await prisma.citizen.update({ where: { cognitoId }, data: { consentRegulation: true } });

      const res = await performRequest(writeApp, "PUT", PROFILE, citizenHeaders, {
        consentRegulation: false,
      });
      const row = await prisma.citizen.findUnique({ where: { cognitoId } });

      recordTest(
        results,
        SUITE,
        "Explicit consentRegulation:false is stored",
        PROFILE,
        "PUT",
        200,
        res.status,
        res.status === 200 && row?.consentRegulation === false,
        row?.consentRegulation !== false ? `consentRegulation=${row?.consentRegulation}` : undefined
      );
    }

    // ── R-05: Admin cannot declare a citizen's information ──────────────────────
    {
      const res = await performRequest(
        writeApp,
        "PUT",
        PROFILE,
        { "x-cognito-id": cognitoId, "x-role": "admin" },
        { fullName: "Declared By Admin" }
      );
      recordTest(
        results,
        SUITE,
        "Reject profile declaration by admin role",
        PROFILE,
        "PUT",
        403,
        res.status,
        res.status === 403
      );
    }

    // ── R-06: Unknown group falls through to citizen (documented fail-open) ─────
    // extractRole() maps every non-admin group to "citizen", so `staff` is admitted.
    // Expectation 200 documents today's behaviour; flip to 403 when the role model is fixed.
    {
      const res = await performRequest(
        writeApp,
        "PUT",
        PROFILE,
        { "x-cognito-id": cognitoId, "x-role": "staff" },
        { fullName: "Nguyen Thi Lan" }
      );
      recordTest(
        results,
        SUITE,
        "Unknown role 'staff' falls through to citizen (fail-open)",
        PROFILE,
        "PUT",
        200,
        res.status,
        res.status === 200,
        res.status === 200
          ? "Known gap: extractRole() admits any non-admin group as citizen"
          : undefined
      );
    }

    // ── R-07: Declaring information for a citizen row that does not exist ───────
    {
      const res = await performRequest(
        writeApp,
        "PUT",
        PROFILE,
        { "x-cognito-id": unknownCognitoId, "x-role": "citizen" },
        { fullName: "Ghost Citizen" }
      );
      recordTest(
        results,
        SUITE,
        "Reject declaration for non-existent citizen row",
        PROFILE,
        "PUT",
        404,
        res.status,
        res.status === 404
      );
    }

    // ── R-08: Reading a profile that was never registered ──────────────────────
    {
      const res = await performRequest(readApp, "GET", PROFILE, {
        "x-cognito-id": unknownCognitoId,
        "x-role": "citizen",
      });
      recordTest(
        results,
        SUITE,
        "Return 404 for unregistered citizen profile",
        PROFILE,
        "GET",
        404,
        res.status,
        res.status === 404
      );
    }
  } finally {
    await prisma.citizen.deleteMany({ where: { id: seeded.id } });
  }
}
