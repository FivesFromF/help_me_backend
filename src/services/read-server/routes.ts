import { Router, Request, Response } from "express";
import { prisma } from "../../shared/db";
import { verifyHashId } from "../../shared/services/hash.service";
import { extractFaceFeature } from "../../shared/services/ai.service";
import { publishEmergencyEvent, publishSystemEvent } from "../../shared/services/events.service";
import { getScanJob } from "../../shared/services/job.service";
import { hasActiveSession } from "./services/session.service";
import { requireRole } from "../../shared/middleware/auth";

export const readRouter = Router();

// Health check endpoint (for ALB and ECS target group)
readRouter.get(["/health", "/read-service/health"], (req: Request, res: Response) => {
  res.status(200).json({ status: "ok", service: "read-server" });
});

// GET Citizen Profile
readRouter.get(
  ["/api/v1/read/citizen/profile", "/citizen/profile", "/api/v1/citizen/profile"],
  requireRole(["citizen"]),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const userId = req.auth!.userId;
      const profile = await prisma.citizen.findUnique({
        where: { cognitoId: userId },
      });

      if (!profile) {
        res.status(404).json({ error: "Profile not found" });
        return;
      }

      res.status(200).json({ profile });
    } catch (err: any) {
      console.error("[read-server.routes] Error fetching profile:", err);
      res.status(500).json({ error: err.message || "Failed to fetch profile" });
    }
  }
);

// GET Medical Record
readRouter.get(
  ["/api/v1/read/citizen/medical-record", "/citizen/medical-record", "/api/v1/citizen/medical-record"],
  requireRole(["citizen"]),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const userId = req.auth!.userId;
      const profile = await prisma.citizen.findUnique({
        where: { cognitoId: userId },
        select: { id: true },
      });

      if (!profile) {
        res.status(404).json({ error: "Profile not found" });
        return;
      }

      const record = await prisma.medicalRecord.findUnique({
        where: { citizenId: profile.id },
      });

      res.status(200).json({ record: record || {} });
    } catch (err: any) {
      console.error("[read-server.routes] Error fetching medical record:", err);
      res.status(500).json({ error: err.message || "Failed to fetch medical record" });
    }
  }
);

// GET NFC Tags
readRouter.get(
  ["/api/v1/read/citizen/nfc-tags", "/citizen/nfc-tags", "/api/v1/citizen/nfc-tags"],
  requireRole(["citizen"]),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const userId = req.auth!.userId;
      const profile = await prisma.citizen.findUnique({
        where: { cognitoId: userId },
        select: { id: true },
      });

      if (!profile) {
        res.status(404).json({ error: "Profile not found" });
        return;
      }

      const tags = await prisma.nfcTag.findMany({
        where: { citizenId: profile.id },
      });

      res.status(200).json({ tags });
    } catch (err: any) {
      console.error("[read-server.routes] Error fetching NFC tags:", err);
      res.status(500).json({ error: err.message || "Failed to fetch NFC tags" });
    }
  }
);

// POST Scan (for Responders: Staff/Admin)
readRouter.post(
  ["/api/v1/read/scan", "/scan", "/api/v1/scan"],
  requireRole(["staff", "admin"]),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { userId: responderId, role: responderRole } = req.auth!;
      const body = req.body || {};
      const { method, tagId, hashId, imageBase64 } = body;

      // 1. NFC Method
      if (method === "NFC") {
        if (!tagId || !hashId) {
          res.status(400).json({ error: "Missing tagId or hashId" });
          return;
        }

        const tag = await prisma.nfcTag.findUnique({
          where: { id: tagId },
        });

        if (!tag || tag.status !== "ACTIVE") {
          res.status(404).json({ error: "Tag not found or inactive" });
          return;
        }

        const systemSecret = process.env.SYSTEM_SECRET || "helpme-secret-key";
        if (!verifyHashId(tag.citizenId, systemSecret, hashId)) {
          res.status(403).json({ error: "Invalid hash signature" });
          return;
        }

        const citizen = await prisma.citizen.findUnique({
          where: { id: tag.citizenId },
        });

        const record = await prisma.medicalRecord.findUnique({
          where: { citizenId: tag.citizenId },
        });

        await publishEmergencyEvent("victim.identified", {
          actorId: responderId,
          responderId,
          responderRole,
          targetId: tag.citizenId,
          method: "NFC",
        });

        res.status(200).json({ citizen, record });
        return;
      }

      // 2. FACE Method (Vector Similarity Search via pgvector)
      if (method === "FACE") {
        if (!imageBase64) {
          res.status(400).json({ error: "Missing imageBase64" });
          return;
        }

        const vector = await extractFaceFeature(imageBase64);
        const vectorString = `[${vector.join(",")}]`;

        const results: Array<any> = await prisma.$queryRawUnsafe(
          `SELECT id, cognito_id as "cognitoId", email, full_name as "fullName", phone, avatar_url as "avatarUrl", 
                  date_of_birth as "dateOfBirth", gender, address, cccd_number as "cccdNumber", 
                  emergency_contacts as "emergencyContacts", is_profile_updated as "isProfileUpdated", 
                  is_verified as "isVerified", created_at as "createdAt", updated_at as "updatedAt",
                  (face_embedding <=> $1::vector) AS distance 
           FROM citizens 
           WHERE face_embedding IS NOT NULL AND (face_embedding <=> $1::vector) < 0.35 
           ORDER BY distance ASC 
           LIMIT 1`,
          vectorString
        );

        if (results.length === 0) {
          res.status(404).json({ error: "No match found with required similarity threshold" });
          return;
        }

        const match = results[0];
        const record = await prisma.medicalRecord.findUnique({
          where: { citizenId: match.id },
        });

        await publishEmergencyEvent("victim.identified", {
          actorId: responderId,
          responderId,
          responderRole,
          targetId: match.id,
          method: "FACE",
          metadata: { distance: match.distance },
        });

        res.status(200).json({ citizen: match, record, distance: match.distance });
        return;
      }

      res.status(400).json({ error: "Invalid scan method. Must be 'NFC' or 'FACE'" });
    } catch (err: any) {
      console.error("[read-server.routes] Error during scan:", err);
      res.status(500).json({ error: err.message || "Scan failed" });
    }
  }
);

// GET Victim Record (Re-access within 1-hour session window)
readRouter.get(
  ["/api/v1/read/victim/:victimId", "/victim/:victimId", "/api/v1/victim/:victimId"],
  requireRole(["staff", "admin"]),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { userId: responderId, role: responderRole } = req.auth!;
      const { victimId } = req.params;

      if (!victimId) {
        res.status(400).json({ error: "Missing victimId" });
        return;
      }

      const hasSession = await hasActiveSession(responderId, victimId);
      if (!hasSession) {
        res.status(403).json({
          error: "No active access session. Scan the victim to obtain temporary access.",
        });
        return;
      }

      const citizen = await prisma.citizen.findUnique({
        where: { id: victimId },
      });

      if (!citizen) {
        res.status(404).json({ error: "Victim profile not found" });
        return;
      }

      const record = await prisma.medicalRecord.findUnique({
        where: { citizenId: victimId },
      });

      await publishSystemEvent("victim.record.accessed", {
        actorId: responderId,
        responderId,
        responderRole,
        targetId: victimId,
        method: "SESSION",
      });

      res.status(200).json({ citizen, record });
    } catch (err: any) {
      console.error("[read-server.routes] Error re-accessing victim record:", err);
      res.status(500).json({ error: err.message || "Failed to retrieve victim record" });
    }
  }
);

// GET Async Scan / AI Job Status
readRouter.get(
  ["/api/v1/read/scan/jobs/:jobId", "/scan/jobs/:jobId", "/api/v1/jobs/:jobId"],
  requireRole(["citizen", "staff", "admin"]),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { jobId } = req.params;
      if (!jobId) {
        res.status(400).json({ error: "Missing jobId" });
        return;
      }

      const job = await getScanJob(jobId);
      if (!job) {
        res.status(404).json({ error: "Job not found" });
        return;
      }

      res.status(200).json({ job });
    } catch (err: any) {
      console.error("[read-server.routes] Error fetching scan job:", err);
      res.status(500).json({ error: err.message || "Failed to fetch scan job" });
    }
  }
);
