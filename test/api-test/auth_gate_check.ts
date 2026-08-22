/**
 * Security regression check: a forged x-cognito-id / x-role header must NOT authenticate when
 * SKIP_AUTH is off. Before auth.ts gated that branch, this request returned 200 as full admin
 * against any deployed environment - no token, no Cognito.
 *
 * It cannot live in the main suite: index.ts forces SKIP_AUTH=true for all 63 checks, and this one
 * needs it off. Run standalone:  npx tsx test/api-test/auth_gate_check.ts   (exit 0 = gate holds)
 */
process.env.SKIP_AUTH = "false";           // must precede the import: auth.ts binds it at load
import { createWriteApp, performRequest } from "./test_helper";

(async () => {
  const app = createWriteApp();
  const forged = { "x-cognito-id": "attacker-no-token", "x-role": "admin" };
  const res = await performRequest(app, "PUT", "/api/citizen/profile", { phone: "+84000000000" }, forged);
  console.log(`forged admin header -> ${res.status} ${res.status === 401 ? "(REJECTED - gate holds)" : "(ACCEPTED - STILL OPEN)"}`);
  process.exit(res.status === 401 ? 0 : 1);
})();
