import { Router, Request, Response } from "express";
import { prisma } from "../../../shared/db";
import { generateHashId } from "../../../shared/services/hash.service";
import { publishSystemEvent } from "../../../shared/services/events.service";
import { requireRole } from "../../../shared/middleware/auth";

export const nfcRoutes = Router();

// POST /api/nfc — Register NFC tag
nfcRoutes.post(
  ["/nfc", "/api/nfc", "/api/v1/write/nfc", "/api/v1/nfc"],
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
      console.error("[nfc.routes] Error registering NFC:", err);
      res.status(500).json({ error: err.message || "Failed to register NFC tag" });
    }
  }
);
