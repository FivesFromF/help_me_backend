import { apiRouter, handleEvent, getAuthContext, requireRole } from "../../utils/router";
import { db } from "../../db";
import { citizens, medicalRecords, nfcTags } from "../../db/schema";
import { eq, sql } from "drizzle-orm";
import { verifyHashId } from "../../services/hash.service";
import { extractFaceFeature } from "../../services/ai.service";
import { publishEmergencyEvent, publishSystemEvent } from "../../services/events.service";
import { hasActiveSession } from "../../services/session.service";

// Middleware (Requires 'citizen' role for all /citizen/* routes)
apiRouter.all("/api/v1/read/citizen/*", requireRole(["citizen"]));

// GET Profile
apiRouter.get("/api/v1/read/citizen/profile", async (req, event) => {
  const { userId } = getAuthContext(event);
  const [profile] = await db.select().from(citizens).where(eq(citizens.cognitoId, userId));
  
  if (!profile) return Response.json({ error: "Profile not found" }, { status: 404 });
  return Response.json({ profile });
});

// GET Medical Record
apiRouter.get("/api/v1/read/citizen/medical-record", async (req, event) => {
  const { userId } = getAuthContext(event);
  const [profile] = await db.select({ id: citizens.id }).from(citizens).where(eq(citizens.cognitoId, userId));
  if (!profile) return Response.json({ error: "Profile not found" }, { status: 404 });

  const [record] = await db.select().from(medicalRecords).where(eq(medicalRecords.citizenId, profile.id));
  return Response.json({ record: record || {} });
});

// GET NFC Tags
apiRouter.get("/api/v1/read/citizen/nfc-tags", async (req, event) => {
  const { userId } = getAuthContext(event);
  const [profile] = await db.select({ id: citizens.id }).from(citizens).where(eq(citizens.cognitoId, userId));
  if (!profile) return Response.json({ error: "Profile not found" }, { status: 404 });

  const tags = await db.select().from(nfcTags).where(eq(nfcTags.citizenId, profile.id));
  return Response.json({ tags });
});

// POST Scan (For Staff/Admin)
apiRouter.post("/api/v1/read/scan", requireRole(["staff", "admin"]), async (req, event) => {
  const { userId: responderId, role: responderRole } = getAuthContext(event);
  const body = await req.json().catch(() => ({}));
  const { method, tagId, hashId, imageBase64 } = body;

  if (method === "NFC") {
    if (!tagId || !hashId) return Response.json({ error: "Missing tagId or hashId" }, { status: 400 });
    
    // 1. Find tag
    const [tag] = await db.select().from(nfcTags).where(eq(nfcTags.id, tagId));
    if (!tag || tag.status !== "ACTIVE") return Response.json({ error: "Tag not found or inactive" }, { status: 404 });
    
    // 2. Verify hash
    const systemSecret = process.env.SYSTEM_SECRET || "";
    if (!verifyHashId(tag.citizenId, systemSecret, hashId)) {
      return Response.json({ error: "Invalid hash signature" }, { status: 403 });
    }
    
    // 3. Valid! Get citizen info
    const [citizen] = await db.select().from(citizens).where(eq(citizens.id, tag.citizenId));
    const [record] = await db.select().from(medicalRecords).where(eq(medicalRecords.citizenId, tag.citizenId));

    // Fire identification event → notify next-of-kin + grant responder a session + audit.
    await publishEmergencyEvent("victim.identified", {
      actorId: responderId,
      responderId,
      responderRole,
      targetId: tag.citizenId,
      method: "NFC",
    });

    return Response.json({ citizen, record });
  }
  
  if (method === "FACE") {
    if (!imageBase64) return Response.json({ error: "Missing imageBase64" }, { status: 400 });
    
    // 1. Extract vector from AI Service
    const vector = await extractFaceFeature(imageBase64);
    
    // 2. Query pgvector cosine similarity < 0.3 (Strict match)
    const vectorString = `[${vector.join(",")}]`;
    const similarity = sql`face_embedding <=> ${vectorString}::vector`;
    
    const results = await db.select({
      citizen: citizens,
      distance: similarity
    })
    .from(citizens)
    .where(sql`${similarity} < 0.3`) 
    .orderBy(similarity)
    .limit(1);
    
    if (results.length === 0) return Response.json({ error: "No match found" }, { status: 404 });
    
    // 3. Valid! Return match
    const match = results[0].citizen;
    const [record] = await db.select().from(medicalRecords).where(eq(medicalRecords.citizenId, match.id));

    await publishEmergencyEvent("victim.identified", {
      actorId: responderId,
      responderId,
      responderRole,
      targetId: match.id,
      method: "FACE",
      metadata: { distance: results[0].distance },
    });

    return Response.json({ citizen: match, record, distance: results[0].distance });
  }

  return Response.json({ error: "Invalid method" }, { status: 400 });
});

// GET Victim Record (re-access after a scan) — gated on an active access session.
// The /read/scan above is the grant point: it fires "victim.identified", which the
// grant-permission-worker turns into a 1-hour session. This endpoint lets a responder
// re-open that victim's record within the window WITHOUT re-scanning, but denies access
// once the session expires (or if they never scanned this victim).
apiRouter.get("/api/v1/read/victim/:victimId", requireRole(["staff", "admin"]), async (req, event) => {
  const { userId: responderId, role: responderRole } = getAuthContext(event);
  const { victimId } = (req as any).params;

  if (!victimId) return Response.json({ error: "Missing victimId" }, { status: 400 });

  if (!(await hasActiveSession(responderId, victimId))) {
    return Response.json(
      { error: "No active access session. Scan the victim to obtain access." },
      { status: 403 }
    );
  }

  const [citizen] = await db.select().from(citizens).where(eq(citizens.id, victimId));
  if (!citizen) return Response.json({ error: "Victim not found" }, { status: 404 });

  const [record] = await db.select().from(medicalRecords).where(eq(medicalRecords.citizenId, victimId));

  // Audit the re-access on the system bus ("which staff viewed whose record, when").
  await publishSystemEvent("victim.record.accessed", {
    actorId: responderId,
    responderId,
    responderRole,
    targetId: victimId,
    method: "SESSION",
  });

  return Response.json({ citizen, record });
});

export const main = handleEvent;
