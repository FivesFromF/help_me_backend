import { Router, Request, Response } from "express";
import { randomUUID } from "crypto";
import { prisma } from "../../shared/db";
import { generateHashId } from "../../shared/services/hash.service";
import { extractFaceFeature } from "../../shared/services/ai.service";
import { publishSystemEvent } from "../../shared/services/events.service";
import { getPresignedUploadUrl } from "../../shared/services/s3.service";
import { createScanJob } from "../../shared/services/job.service";
import { requireRole } from "../../shared/middleware/auth";

export const writeRouter = Router();

// Health check endpoint (for ALB and ECS target group)
writeRouter.get(["/health", "/write-service/health"], (req: Request, res: Response) => {
  res.status(200).json({ status: "ok", service: "write-server" });
});

// Update citizen profile
writeRouter.put(
  ["/api/v1/write/citizen/profile", "/citizen/profile", "/api/v1/citizen/profile"],
  requireRole(["citizen"]),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const userId = req.auth!.userId;
      const body = req.body || {};

      const updated = await prisma.citizen.update({
        where: { cognitoId: userId },
        data: {
          fullName: body.fullName !== undefined ? body.fullName : undefined,
          phone: body.phone !== undefined ? body.phone : undefined,
          address: body.address !== undefined ? body.address : undefined,
          cccdNumber: body.cccdNumber !== undefined ? body.cccdNumber : undefined,
          dateOfBirth: body.dateOfBirth ? new Date(body.dateOfBirth) : undefined,
          gender: body.gender !== undefined ? body.gender : undefined,
          emergencyContacts: body.emergencyContacts !== undefined ? body.emergencyContacts : undefined,
          isProfileUpdated: true,
          firstDeclareProfile: body.firstDeclareProfile ?? true,
          consentRegulation: body.consentRegulation ?? true,
        },
      });

      await publishSystemEvent("citizen.profile.updated", {
        actorId: userId,
        targetId: updated.id,
        metadata: { consent: body.consentRegulation ?? undefined },
      });

      // Separate audit event when user explicitly accepts the regulation
      if (body.consentRegulation === true) {
        await publishSystemEvent("user.consent_accepted", {
          actorId: userId,
          targetId: updated.id,
          metadata: {
            consentVersion: body.consentVersion ?? "1.0",
            firstDeclare: body.firstDeclareProfile ?? false,
          },
        });
      }

      res.status(200).json({ profile: updated });
    } catch (err: any) {
      console.error("[write-server.routes] Error updating profile:", err);
      if (err.code === "P2025") {
        res.status(404).json({ error: "Profile not found" });
        return;
      }
      res.status(500).json({ error: err.message || "Failed to update profile" });
    }
  }
);

// Update or create medical record
writeRouter.put(
  ["/api/v1/write/citizen/medical-record", "/citizen/medical-record", "/api/v1/citizen/medical-record"],
  requireRole(["citizen"]),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const userId = req.auth!.userId;
      const profile = await prisma.citizen.findUnique({
        where: { cognitoId: userId },
        select: { id: true },
      });

      if (!profile) {
        res.status(404).json({ error: "Citizen profile not found" });
        return;
      }

      const body = req.body || {};

      const record = await prisma.medicalRecord.upsert({
        where: { citizenId: profile.id },
        create: {
          citizenId: profile.id,
          distinguishingMarks: body.distinguishingMarks,
          bloodGroup: body.bloodGroup,
          allergies: body.allergies || [],
          backgroundDiseases: body.backgroundDiseases || [],
          currentMedications: body.currentMedications || [],
          notes: body.notes,
        },
        update: {
          distinguishingMarks: body.distinguishingMarks,
          bloodGroup: body.bloodGroup,
          allergies: body.allergies || [],
          backgroundDiseases: body.backgroundDiseases || [],
          currentMedications: body.currentMedications || [],
          notes: body.notes,
          lastUpdated: new Date(),
        },
      });

      await publishSystemEvent("medical_record.updated", {
        actorId: userId,
        targetId: profile.id,
      });

      res.status(200).json({ record });
    } catch (err: any) {
      console.error("[write-server.routes] Error updating medical record:", err);
      res.status(500).json({ error: err.message || "Failed to update medical record" });
    }
  }
);

// Register face biometrics
writeRouter.post(
  ["/api/v1/write/citizen/face", "/citizen/face", "/api/v1/citizen/face"],
  requireRole(["citizen"]),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const userId = req.auth!.userId;
      const body = req.body || {};
      if (!body.imageBase64) {
        res.status(400).json({ error: "Missing imageBase64 in request body" });
        return;
      }

      const vector = await extractFaceFeature(body.imageBase64);
      const vectorString = `[${vector.join(",")}]`;

      await prisma.$executeRawUnsafe(
        `UPDATE citizens SET face_embedding = $1::vector, is_verified = true, updated_at = NOW() WHERE cognito_id = $2`,
        vectorString,
        userId
      );

      await publishSystemEvent("citizen.face.registered", { actorId: userId });

      res.status(200).json({ success: true, message: "Face registered successfully" });
    } catch (err: any) {
      console.error("[write-server.routes] Error registering face:", err);
      res.status(500).json({ error: err.message || "Failed to register face" });
    }
  }
);

// Register NFC tag
writeRouter.post(
  ["/api/v1/write/nfc", "/nfc", "/api/v1/nfc"],
  requireRole(["citizen", "admin"]),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { userId, role } = req.auth!;
      const body = req.body || {};

      let targetCitizenId = body.citizenId;

      if (role === "citizen") {
        const profile = await prisma.citizen.findUnique({
          where: { cognitoId: userId },
          select: { id: true },
        });
        if (!profile) {
          res.status(404).json({ error: "Citizen profile not found" });
          return;
        }
        targetCitizenId = profile.id;
      }

      if (!targetCitizenId) {
        res.status(400).json({ error: "Missing citizenId" });
        return;
      }
      if (!body.tagId) {
        res.status(400).json({ error: "Missing tagId (serial number)" });
        return;
      }

      const systemSecret = process.env.SYSTEM_SECRET || "helpme-secret-key";
      const hashId = generateHashId(targetCitizenId, systemSecret);

      await prisma.nfcTag.upsert({
        where: { id: body.tagId },
        create: {
          id: body.tagId,
          name: body.name || "Default NFC Tag",
          citizenId: targetCitizenId,
          status: "ACTIVE",
        },
        update: {
          name: body.name || "Default NFC Tag",
          citizenId: targetCitizenId,
          status: "ACTIVE",
        },
      });

      await publishSystemEvent("nfc.registered", {
        actorId: userId,
        targetId: targetCitizenId,
        metadata: { tagId: body.tagId, registeredByRole: role },
      });

      res.status(200).json({
        success: true,
        tagId: body.tagId,
        hashIdToBurn: hashId,
      });
    } catch (err: any) {
      console.error("[write-server.routes] Error registering NFC:", err);
      res.status(500).json({ error: err.message || "Failed to register NFC tag" });
    }
  }
);

// Emergency Report
writeRouter.post(
  ["/api/v1/write/emergency/report", "/emergency/report", "/api/v1/emergency/report"],
  requireRole(["citizen", "admin"]),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { userId } = req.auth!;
      const body = req.body || {};

      if (!body.locationLat || !body.locationLon) {
        res.status(400).json({ error: "Missing location coordinates" });
        return;
      }

      const report = await prisma.emergencyReport.create({
        data: {
          victimId: body.victimId || null,
          locationLat: String(body.locationLat),
          locationLon: String(body.locationLon),
          situationDescription: body.situationDescription || "",
          status: "PENDING",
        },
      });

      await publishSystemEvent("emergency.reported", {
        actorId: userId,
        targetId: body.victimId,
        metadata: { reportId: report.id },
      });

      res.status(201).json({ report });
    } catch (err: any) {
      console.error("[write-server.routes] Error reporting emergency:", err);
      res.status(500).json({ error: err.message || "Failed to report emergency" });
    }
  }
);

// Generate Presigned Upload URL for Async AI Processing
writeRouter.post(
  ["/api/v1/write/upload-url", "/upload-url", "/api/v1/upload-url"],
  requireRole(["citizen", "admin"]),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { userId, role } = req.auth!;
      const body = req.body || {};
      const { fileType = "image/jpeg", operation = "FACE_SCAN", citizenId } = body;

      const jobId = randomUUID();
      const ext = fileType.includes("png") ? "png" : "jpg";
      const prefix = operation === "ENROLLMENT" ? "raw-uploads" : "raw-scans";
      const s3Key = `${prefix}/${jobId}.${ext}`;

      const uploadUrl = await getPresignedUploadUrl(s3Key, fileType);

      // Initialize job record in DynamoDB (expires in 2 hours)
      const now = Math.floor(Date.now() / 1000);
      await createScanJob({
        job_id: jobId,
        status: "PENDING",
        operation: operation === "ENROLLMENT" ? "ENROLLMENT" : "FACE_SCAN",
        responder_id: userId,
        citizen_id: citizenId || (role === "citizen" ? userId : undefined),
        s3_key: s3Key,
        created_at: new Date().toISOString(),
        expires_at: now + 7200,
      });

      res.status(200).json({
        jobId,
        uploadUrl,
        s3Key,
        expiresInSeconds: 3600,
      });
    } catch (err: any) {
      console.error("[write-server.routes] Error generating upload URL:", err);
      res.status(500).json({ error: err.message || "Failed to generate upload URL" });
    }
  }
);
