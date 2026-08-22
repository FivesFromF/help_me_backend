# EventBridge & Serverless Event Sync

## 📡 Event Buses

1. **`CORE_SYSTEM_BUS`**: Handles lifecycle, profile updates, audit tracking, and system maintenance events.
2. **`EMERGENCY_BUS`**: High-priority bus dedicated to emergency incidents, SOS triggers, responder broadcasts, and temporary access grants.

---

## ⚙️ Event Workers (AWS Lambdas)

| Worker | Trigger Bus | Responsibility |
| :--- | :--- | :--- |
| **`post-confirmation`** | Cognito Trigger | Assigns the `Citizens` group and publishes `user.signed_up`. It does **not** create the citizen row - see below. |
| **`audit-worker`** | `CORE_SYSTEM_BUS` | Records compliance actions, medical access events, and authentication changes. |
| **`notification-worker`** | `EMERGENCY_BUS` | Sends emergency alerts via SMS/Email and pushes notifications to emergency contacts. |
| **`grant-permission-worker`** | `EMERGENCY_BUS` | **Retired** - a no-op kept so its rule has a target. Access grants are written by the scan route and the AI worker. |

> **The citizen row is created by the API, not by `post-confirmation`.**
> `shared/services/provision.service.ts` upserts it on the first authenticated request, from the
> `sub` claim - the same claim every lookup uses. The trigger keeps only Cognito-side work.
>
> This is deliberate, and the reasons are worth knowing before anyone moves it back. The trigger
> runs exactly once with no retry; its `catch` only logs and `main` returns the event regardless, so
> Cognito confirms the user either way; and it wrote `event.userName`, which for a federated sign-in
> is `Google_100401295688952411752` while the token's `sub` is a different UUID entirely - so even a
> successful write produced a row the API could never find. A failure left a confirmed user who
> could sign in, hold a valid token, and get `404` on every route forever, because no HTTP route
> created that row either.
>
> Provisioning in the API makes both failure modes structurally impossible: the identifier cannot
> drift, and a missing row repairs itself on the next request. `post-confirmation` deliberately does
> **not** throw - everything left in it is non-critical, and throwing would make Cognito reject the
> whole sign-up over a missing group.
>
> It is also the only publisher in `src/` that builds `new EventBridgeClient({})` with no endpoint
> override, so `event_capture.ts` cannot see its events; testing it needs
> `AWS_ENDPOINT_URL_EVENTBRIDGE`.

> **Access grants no longer come from an event.** `grant-permission-worker` wrote them to DynamoDB
> until 2026-08-22. Sessions now live in Postgres and that Lambda has no VPC configuration, so it
> cannot reach RDS; granting moved into `read-server/routes/scan.routes.ts` and `worker.py`, both of
> which run inside the VPC. Doing it there also removed a race - the scan response had always
> claimed `accessGranted: true` while the row was written asynchronously afterwards. See
> [[Architecture/Authentication_and_Audit]] for the session model itself.

---

## 🧪 What is verified

`npm run test:api` covers both halves of this diagram: §9 asserts that each route publishes its
documented event **to the documented bus**, and §10 hands those captured events to the real
handlers and asserts the effect — the access session, the audit row, the alert email. The chain
check (scan → `victim.identified` → `grant-permission-worker` → victim record readable) is the
one that proves the buses are wired end to end. See [[Services/API_Reference_and_Tests]].

`victim.identified` must stay on **`EMERGENCY_BUS`**: `grant-permission-worker` and
`notification-worker` subscribe to it there, so publishing it to the system bus would strand
every downstream alert while the scan itself still returned `200`.

The audit worker reads **`AUDIT_TABLE_NAME`** and drops events when it is unset — see
[[Runbooks/Local_Testing]].

The alert email itself is proven separately by `npm run test:notify -- <address>`, which sends one
real message through the configured provider — the automated suite always uses a local sink.
