import { Router, Request, Response } from "express";
import { prisma } from "../../../shared/db";
import { publishSystemEvent } from "../../../shared/services/events.service";
import { requireRole } from "../../../shared/middleware/auth";

export const emergencyRoutes = Router();

// POST /api/emergency/report — Emergency incident reporting
emergencyRoutes.post(
  ["/emergency/report", "/api/emergency/report", "/api/v1/write/emergency/report", "/api/v1/emergency/report"],
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
      console.error("[emergency.routes] Error reporting emergency:", err);
      res.status(500).json({ error: err.message || "Failed to report emergency" });
    }
  }
);
