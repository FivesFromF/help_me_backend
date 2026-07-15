import { apiRouter, handleEvent, getAuthContext, requireRole } from "../../utils/router";
import { db } from "../../db";
import { citizens, medicalRecords, nfcTags } from "../../db/schema";
import { eq } from "drizzle-orm";
import { generateHashId } from "../../services/hash.service";
import { extractFaceFeature } from "../../services/ai.service";
import { publishSystemEvent } from "../../services/events.service";

// Middleware
apiRouter.all("/api/v1/write/citizen/*", requireRole(["citizen"]));

// PUT Profile
apiRouter.put("/api/v1/write/citizen/profile", async (req, event) => {
  const { userId } = getAuthContext(event);
  const body = await req.json().catch(() => ({}));
  
  // Drizzle update
  const updated = await db.update(citizens)
    .set({
      fullName: body.fullName,
      phone: body.phone,
      address: body.address,
      cccdNumber: body.cccdNumber,
      dateOfBirth: body.dateOfBirth ? new Date(body.dateOfBirth).toISOString().split('T')[0] : null,
      gender: body.gender,
      isProfileUpdated: true,
      updatedAt: new Date(),
    })
    .where(eq(citizens.cognitoId, userId))
    .returning();

  await publishSystemEvent("citizen.profile.updated", {
    actorId: userId,
    targetId: updated[0]?.id,
    metadata: { consent: body.consentRegulation ?? undefined },
  });

  return Response.json({ profile: updated[0] });
});

// PUT Medical Record
apiRouter.put("/api/v1/write/citizen/medical-record", async (req, event) => {
  const { userId } = getAuthContext(event);
  const [profile] = await db.select({ id: citizens.id }).from(citizens).where(eq(citizens.cognitoId, userId));
  if (!profile) return Response.json({ error: "Profile not found" }, { status: 404 });

  const body = await req.json().catch(() => ({}));
  
  const updated = await db.insert(medicalRecords)
    .values({
      citizenId: profile.id,
      distinguishingMarks: body.distinguishingMarks,
      bloodGroup: body.bloodGroup,
      allergies: body.allergies,
      backgroundDiseases: body.backgroundDiseases,
      currentMedications: body.currentMedications,
      notes: body.notes,
      lastUpdated: new Date()
    })
    .onConflictDoUpdate({
      target: medicalRecords.citizenId,
      set: {
        distinguishingMarks: body.distinguishingMarks,
        bloodGroup: body.bloodGroup,
        allergies: body.allergies,
        backgroundDiseases: body.backgroundDiseases,
        currentMedications: body.currentMedications,
        notes: body.notes,
        lastUpdated: new Date()
      }
    })
    .returning();

  await publishSystemEvent("medical_record.updated", {
    actorId: userId,
    targetId: profile.id,
  });

  return Response.json({ record: updated[0] });
});

// POST Face Registration
apiRouter.post("/api/v1/write/citizen/face", async (req, event) => {
  const { userId } = getAuthContext(event);
  const body = await req.json().catch(() => ({}));
  if (!body.imageBase64) return Response.json({ error: "Missing imageBase64" }, { status: 400 });
  
  try {
    const vector = await extractFaceFeature(body.imageBase64);
    
    // Save to DB (pgvector driver handles array stringification via customType we defined)
    await db.update(citizens)
      .set({ faceEmbedding: vector })
      .where(eq(citizens.cognitoId, userId));

    await publishSystemEvent("citizen.face.registered", { actorId: userId });

    return Response.json({ success: true, message: "Face registered successfully" });
  } catch (err: any) {
    return Response.json({ error: err.message }, { status: 500 });
  }
});

// POST Register NFC
apiRouter.post("/api/v1/write/nfc", requireRole(["citizen", "staff", "admin"]), async (req, event) => {
  const { userId, role } = getAuthContext(event);
  const body = await req.json().catch(() => ({}));
  
  let targetCitizenId = body.citizenId;
  
  // If role is citizen, force it to their own ID
  if (role === "citizen") {
    const [profile] = await db.select({ id: citizens.id }).from(citizens).where(eq(citizens.cognitoId, userId));
    if (!profile) return Response.json({ error: "Profile not found" }, { status: 404 });
    targetCitizenId = profile.id;
  }
  
  if (!targetCitizenId) return Response.json({ error: "Missing citizenId" }, { status: 400 });
  if (!body.tagId) return Response.json({ error: "Missing tagId (serial number)" }, { status: 400 });
  
  const systemSecret = process.env.SYSTEM_SECRET || "";
  const hashId = generateHashId(targetCitizenId, systemSecret);
  
  // Register in DB
  await db.insert(nfcTags).values({
    id: body.tagId,
    name: body.name || "Default NFC Tag",
    citizenId: targetCitizenId,
    status: "ACTIVE"
  });
  
  await publishSystemEvent("nfc.registered", {
    actorId: userId,
    targetId: targetCitizenId,
    metadata: { tagId: body.tagId, registeredByRole: role },
  });

  // Return the Hash_ID so the App can write it to the physical NFC tag
  return Response.json({
    success: true,
    tagId: body.tagId,
    hashIdToBurn: hashId
  });
});

export const main = handleEvent;
