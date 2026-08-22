import { Router, Request, Response } from "express";
import { prisma } from "../../../shared/db";
import { extractFaceFeature } from "../../../shared/services/ai.service";
import { publishSystemEvent } from "../../../shared/services/events.service";
import { requireRole } from "../../../shared/middleware/auth";

export const citizenRoutes = Router();

// PUT /api/citizen/profile — Update citizen profile & consent
citizenRoutes.put(
  ["/citizen/profile", "/api/citizen/profile", "/api/v1/write/citizen/profile", "/api/v1/citizen/profile"],
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
          // `!== undefined` chứ KHÔNG phải `?? true`: đây là API cập nhật từng phần, Prisma coi
          // `undefined` là "không đụng tới cột này". Với `?? true`, một request chỉ sửa số điện
          // thoại cũng lặng lẽ bật lại consent đã bị rút — và sự kiện audit `user.consent_accepted`
          // bên dưới chỉ bắn khi client gửi `true` tường minh, nên DB ghi có consent mà audit
          // trail không có bằng chứng nào. Xem R-03 trong test/api-test/README.md.
          firstDeclareProfile: body.firstDeclareProfile !== undefined ? body.firstDeclareProfile : undefined,
          consentRegulation: body.consentRegulation !== undefined ? body.consentRegulation : undefined,
        },
      });

      await publishSystemEvent("citizen.profile.updated", {
        actorId: userId,
        targetId: updated.id,
        metadata: { consent: body.consentRegulation ?? undefined },
      });

      // Separate audit event when user explicitly accepts regulation
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
      console.error("[citizen.routes] Error updating profile:", err);
      if (err.code === "P2025") {
        res.status(404).json({ error: "Profile not found" });
        return;
      }
      res.status(500).json({ error: err.message || "Failed to update profile" });
    }
  }
);

// PUT /api/citizen/medical-record — Create or update medical facts
citizenRoutes.put(
  ["/citizen/medical-record", "/api/citizen/medical-record", "/api/v1/write/citizen/medical-record", "/api/v1/citizen/medical-record"],
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
      console.error("[citizen.routes] Error updating medical record:", err);
      res.status(500).json({ error: err.message || "Failed to update medical record" });
    }
  }
);

// POST /api/citizen/face — Register face biometrics
citizenRoutes.post(
  ["/citizen/face", "/api/citizen/face", "/api/v1/write/citizen/face", "/api/v1/citizen/face"],
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
      console.error("[citizen.routes] Error registering face:", err);
      res.status(500).json({ error: err.message || "Failed to register face" });
    }
  }
);
