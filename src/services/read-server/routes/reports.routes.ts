import { Router, Request, Response } from "express";
import { prisma } from "../../../shared/db";
import { requireRole } from "../../../shared/middleware/auth";

/**
 * A citizen's view of emergency reports - the ones they raised, and the ones raised about them.
 *
 * Both directions matter and they are not the same list. Someone who calls for help on a stranger's
 * behalf needs to follow what happened to that call; someone who was found unconscious needs to see
 * that a report exists about them at all. `reporter_id` and `victim_id` are separate columns for
 * exactly this reason, and until now neither was ever read back.
 *
 * Admin-side listing lives in admin.routes.ts; this route never exposes another citizen's report.
 */
export const reportRoutes = Router();

/** Fields safe to return to a citizen. Deliberately excludes nothing today, but is explicit so a
 *  later column (dispatcher notes, responder identity) is not leaked by accident. */
const REPORT_FIELDS = {
  id: true,
  reporterId: true,
  victimId: true,
  locationLat: true,
  locationLon: true,
  situationDescription: true,
  status: true,
  accessSessionId: true,
  createdAt: true,
  updatedAt: true,
} as const;

async function myCitizenId(req: Request): Promise<string | null> {
  const profile = await prisma.citizen.findUnique({
    where: { cognitoId: req.auth!.userId },
    select: { id: true },
  });
  return profile?.id ?? null;
}

// ─── GET /api/v1/citizen/reports — reports I raised or that concern me ────────
reportRoutes.get(
  ["/citizen/reports", "/api/citizen/reports", "/api/v1/read/citizen/reports", "/api/v1/citizen/reports"],
  requireRole(["citizen", "admin"]),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const citizenId = await myCitizenId(req);
      if (!citizenId) {
        res.status(404).json({ error: "Citizen profile not found" });
        return;
      }

      const status = typeof req.query.status === "string" ? req.query.status.toUpperCase() : undefined;
      const take = Math.min(Math.max(parseInt(String(req.query.limit ?? "25"), 10) || 25, 1), 100);
      const skip = Math.max(parseInt(String(req.query.offset ?? "0"), 10) || 0, 0);

      const where = {
        OR: [{ reporterId: citizenId }, { victimId: citizenId }],
        ...(status ? { status } : {}),
      };

      const [total, rows] = await Promise.all([
        prisma.emergencyReport.count({ where }),
        prisma.emergencyReport.findMany({
          where,
          select: REPORT_FIELDS,
          orderBy: { createdAt: "desc" },
          take,
          skip,
        }),
      ]);

      res.status(200).json({
        total,
        limit: take,
        offset: skip,
        reports: rows.map((r) => ({
          ...r,
          // Lets a client render "you reported this" vs "this was reported about you" without
          // having to know its own citizen id.
          role: r.reporterId === citizenId ? "reporter" : "victim",
          // "identified" = báo sau khi quét NFC/QR/khuôn mặt; "standalone" = báo từ trang chính.
          origin: r.accessSessionId ? "identified" : "standalone",
        })),
      });
    } catch (err: any) {
      console.error("[reports] list failed:", err);
      res.status(500).json({ error: err.message || "Failed to load reports" });
    }
  }
);

// ─── GET /api/v1/citizen/reports/:reportId — one report, if it is mine ────────
reportRoutes.get(
  [
    "/citizen/reports/:reportId",
    "/api/citizen/reports/:reportId",
    "/api/v1/read/citizen/reports/:reportId",
    "/api/v1/citizen/reports/:reportId",
  ],
  requireRole(["citizen", "admin"]),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { reportId } = req.params;
      const report = await prisma.emergencyReport.findUnique({
        where: { id: reportId },
        select: REPORT_FIELDS,
      });
      if (!report) {
        res.status(404).json({ error: "Report not found" });
        return;
      }

      if (req.auth!.role !== "admin") {
        const citizenId = await myCitizenId(req);
        const mine = !!citizenId && (report.reporterId === citizenId || report.victimId === citizenId);
        if (!mine) {
          // 404 rather than 403: a stranger should not learn that this report id exists at all.
          res.status(404).json({ error: "Report not found" });
          return;
        }
      }

      res.status(200).json({ report });
    } catch (err: any) {
      console.error("[reports] detail failed:", err);
      res.status(500).json({ error: err.message || "Failed to load report" });
    }
  }
);
