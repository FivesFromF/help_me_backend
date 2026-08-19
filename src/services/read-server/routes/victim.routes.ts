import { Router, Request, Response } from "express";
import { prisma } from "../../../shared/db";
import { hasActiveSession } from "../services/session.service";
import { publishSystemEvent } from "../../../shared/services/events.service";
import { requireRole } from "../../../shared/middleware/auth";

export const victimRoutes = Router();

// GET /api/victim/:victimId — Re-access victim medical record within 1-hour session window
victimRoutes.get(
  ["/victim/:victimId", "/api/victim/:victimId", "/api/v1/read/victim/:victimId", "/api/v1/victim/:victimId"],
  requireRole(["citizen", "admin"]),
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
      console.error("[victim.routes] Error re-accessing victim record:", err);
      res.status(500).json({ error: err.message || "Failed to retrieve victim record" });
    }
  }
);
