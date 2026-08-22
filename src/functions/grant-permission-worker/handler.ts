/**
 * RETIRED 2026-08-22 - kept as a no-op so the EventBridge rule has a live target.
 *
 * This worker used to write the 1-hour access grant into the DynamoDB table
 * `helpme-access-sessions`. Sessions now live in Postgres (`access_sessions`), and this Lambda has
 * no VPC configuration, so it cannot reach RDS at all - the same wall `post-confirmation` hit.
 *
 * Granting moved to where identification actually happens: `read-server/routes/scan.routes.ts` and
 * the Python AI worker, both of which run inside the VPC with a live database connection. That is
 * strictly better than what this did, because the grant is now synchronous with the scan response.
 * Previously the response claimed `accessGranted: true` while this worker raced to write the row.
 *
 * Left in place rather than deleted: removing it means removing the EventBridge rule and target in
 * `infra/modules/eventbridge` too, which is a separate infrastructure change. Until then it should
 * do nothing loudly rather than fail quietly.
 */
export const main = async (event: any) => {
  const detail = event.detail ?? {};
  const responderId = detail.responderId ?? detail.actorId;
  const victimId = detail.targetId ?? detail.victimId;

  console.log(
    `[grant] no-op: access sessions moved to Postgres and are granted by the scan path ` +
      `(responder=${responderId ?? "?"} victim=${victimId ?? "?"})`
  );
};
