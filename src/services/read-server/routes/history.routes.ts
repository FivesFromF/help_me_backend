import { Router, Request, Response } from "express";
import { prisma } from "../../../shared/db";
import { requireRole } from "../../../shared/middleware/auth";
import { expireElapsedSessions, SESSION_ACTIVE } from "../services/session.service";
import { resolveAvatarUrl } from "../../../shared/services/s3.service";

/**
 * A citizen's activity history, in the three strands they care about:
 *
 *   accessGranted  - records I can (or could) open, because I identified someone
 *   accessReceived - people who opened MY record, which is the accountability half
 *   reports        - emergency reports I raised
 *
 * Both access strands come from the same `access_sessions` rows read from opposite ends: I am the
 * `responderId` in one and the `victimId` in the other. Keeping expired sessions rather than
 * deleting them is what makes this page possible at all - a purge would erase exactly the history
 * a citizen has the strongest right to see.
 *
 * Every row carries what the client needs to navigate: an access row points at the victim's health
 * record, a report row at the report. `canView` says whether that navigation will actually succeed,
 * so an expired grant can be rendered as history rather than as a dead link.
 */
export const historyRoutes = Router();

const clamp = (v: unknown, def: number, max: number) =>
  Math.min(Math.max(parseInt(String(v ?? def), 10) || def, 1), max);

/**
 * Turns responder ids into names. `responderId` is a Cognito sub, so it may belong to a citizen or
 * to an admin - or to neither, if the account is gone. Unresolved ids are returned as-is rather
 * than hidden: "someone opened your record" is still true and still worth showing.
 */
async function resolveActors(ids: string[]) {
  const unique = [...new Set(ids.filter(Boolean))];
  if (!unique.length) return new Map<string, { name: string; role: string }>();

  const [citizens, admins] = await Promise.all([
    prisma.citizen.findMany({
      where: { cognitoId: { in: unique } },
      select: { cognitoId: true, fullName: true },
    }),
    prisma.admin.findMany({
      where: { cognitoId: { in: unique } },
      select: { cognitoId: true, fullName: true },
    }),
  ]);

  const map = new Map<string, { name: string; role: string }>();
  for (const c of citizens) map.set(c.cognitoId, { name: c.fullName || "Unnamed citizen", role: "citizen" });
  for (const a of admins) map.set(a.cognitoId, { name: a.fullName, role: "admin" });
  return map;
}

// ─── GET /api/v1/citizen/history ──────────────────────────────────────────────
historyRoutes.get(
  ["/citizen/history", "/api/citizen/history", "/api/v1/read/citizen/history", "/api/v1/citizen/history"],
  requireRole(["citizen", "admin"]),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { userId } = req.auth!;
      const limit = clamp(req.query.limit, 25, 100);

      const me = await prisma.citizen.findUnique({
        where: { cognitoId: userId },
        select: { id: true },
      });
      if (!me) {
        res.status(404).json({ error: "Citizen profile not found" });
        return;
      }

      // Settle statuses first so ACTIVE genuinely means active on this page.
      await expireElapsedSessions();

      const now = Date.now();
      const [granted, received, reports] = await Promise.all([
        // Sessions where I am the responder - people whose record I identified.
        // `victimId` is a plain uuid column - AccessSession has no relation to Citizen, so the
        // victims are resolved in one follow-up query rather than joined.
        prisma.accessSession.findMany({
          where: { responderId: userId },
          orderBy: { grantedAt: "desc" },
          take: limit,
        }),
        // Sessions where I am the victim - who has opened my record.
        prisma.accessSession.findMany({
          where: { victimId: me.id },
          orderBy: { grantedAt: "desc" },
          take: limit,
        }),
        prisma.emergencyReport.findMany({
          where: { OR: [{ reporterId: me.id }, { reporterId: userId }] },
          orderBy: { createdAt: "desc" },
          take: limit,
          include: { victim: { select: { id: true, fullName: true } } },
        }),
      ]);

      const actors = await resolveActors(received.map((s) => s.responderId));

      const victimRows = await prisma.citizen.findMany({
        where: { id: { in: [...new Set(granted.map((s) => s.victimId))] } },
        select: { id: true, fullName: true, avatarUrl: true },
      });
      // avatar_url là S3 key trên bucket private; ký từng cái trước khi trả về, nếu không client
      // nhận một chuỗi key và hiển thị ảnh hỏng.
      const signedVictims = await Promise.all(
        victimRows.map(async (v) => ({ ...v, avatarUrl: await resolveAvatarUrl(v.avatarUrl) }))
      );
      const victims = new Map(signedVictims.map((v) => [v.id, v]));

      const isLive = (s: { status: string; expiresAt: Date }) =>
        s.status === SESSION_ACTIVE && s.expiresAt.getTime() > now;

      res.status(200).json({
        accessGranted: granted.map((s) => ({
          sessionId: s.id,
          victim: victims.get(s.victimId) ?? null,
          method: s.method,
          grantedAt: s.grantedAt,
          expiresAt: s.expiresAt,
          status: s.status,
          secondsRemaining: Math.max(0, Math.floor((s.expiresAt.getTime() - now) / 1000)),
          // Tapping the row opens this citizen's health record. False once the hour is up: the
          // row stays as history, but GET /api/v1/victim/:id would refuse it.
          canView: isLive(s),
          victimId: s.victimId,
        })),

        accessReceived: received.map((s) => ({
          sessionId: s.id,
          responderId: s.responderId,
          responder: actors.get(s.responderId) ?? { name: "Unknown responder", role: "unknown" },
          method: s.method,
          grantedAt: s.grantedAt,
          expiresAt: s.expiresAt,
          status: s.status,
          // Not navigable: this is somebody else's access to me, shown for accountability.
          canView: false,
          // I may object to this access. Allowed on an expired session too - misuse is usually
          // noticed after the fact - but not twice on the same one.
          canComplain: s.status !== "COMPLAINED",
          complainedAt: s.complainedAt,
          complaintReason: s.complaintReason,
        })),

        reports: reports.map((r) => ({
          reportId: r.id,
          victim: r.victim,
          status: r.status,
          origin: r.accessSessionId ? "identified" : "standalone",
          accessSessionId: r.accessSessionId,
          situationDescription: r.situationDescription,
          locationLat: r.locationLat,
          locationLon: r.locationLon,
          createdAt: r.createdAt,
          canView: true,
        })),
      });
    } catch (err: any) {
      console.error("[history] failed:", err);
      res.status(500).json({ error: err.message || "Failed to load history" });
    }
  }
);
