process.env.SKIP_AUTH = "true";
import { prisma } from "../../src/shared/db";
import { hasActiveSession, grantAccessSession, expireElapsedSessions, listActiveSessions } from "../../src/services/read-server/services/session.service";

(async () => {
  const c = await prisma.citizen.create({ data: { cognitoId: `exp-${Date.now()}`, email: `exp-${Date.now()}@t.local`, fullName: "Expiry Test" } });
  const responder = `resp-${Date.now()}`;

  await grantAccessSession(responder, c.id, "NFC");
  let row = await prisma.accessSession.findUnique({ where: { responderId_victimId: { responderId: responder, victimId: c.id } } });
  console.log(`after grant        status=${row?.status}  active=${await hasActiveSession(responder, c.id)}`);

  // wind the clock back so it is due to expire, without waiting an hour
  await prisma.accessSession.update({ where: { id: row!.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
  console.log(`elapsed, unswept   status=ACTIVE  active=${await hasActiveSession(responder, c.id)}   <- must be false`);

  const n = await expireElapsedSessions();
  row = await prisma.accessSession.findUnique({ where: { id: row!.id } });
  console.log(`after sweep (${n})    status=${row?.status}  row still exists=${!!row}`);

  const live = await listActiveSessions();
  console.log(`admin monitor      shows this one=${live.some((s) => s.id === row!.id)}   <- must be false`);

  await grantAccessSession(responder, c.id, "QR");
  row = await prisma.accessSession.findUnique({ where: { id: row!.id } });
  console.log(`re-scan reactivates status=${row?.status}  active=${await hasActiveSession(responder, c.id)}`);

  await prisma.accessSession.deleteMany({ where: { responderId: responder } });
  await prisma.citizen.delete({ where: { id: c.id } }).catch(() => {});
  await prisma.$disconnect();
})();
