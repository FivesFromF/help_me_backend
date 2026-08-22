# EventBridge & Serverless Event Sync

## 📡 Event Buses

1. **`CORE_SYSTEM_BUS`**: Handles lifecycle, profile updates, audit tracking, and system maintenance events.
2. **`EMERGENCY_BUS`**: High-priority bus dedicated to emergency incidents, SOS triggers, responder broadcasts, and temporary access grants.

---

## ⚙️ Event Workers (AWS Lambdas)

| Worker | Trigger Bus | Responsibility |
| :--- | :--- | :--- |
| **`post-confirmation`** | Cognito Trigger | Triggered right after citizen confirms email; automatically creates citizen skeleton row in database. |
| **`audit-worker`** | `CORE_SYSTEM_BUS` | Records compliance actions, medical access events, and authentication changes. |
| **`notification-worker`** | `EMERGENCY_BUS` | Sends emergency alerts via SMS/Email and pushes notifications to emergency contacts. |
| **`grant-permission-worker`** | `EMERGENCY_BUS` | Grants time-limited emergency authorization to authorized responders to access full medical history. |

> **⚠️ `post-confirmation` cannot report its own failure.** The handler body sits in a single
> `try` whose `catch` only logs, and `main` returns the event regardless — so Cognito confirms the
> user either way. Two paths reach that catch: `AdminListGroupsForUser` is the first await, so any
> Cognito error skips the citizen insert below it; and `citizens.email` is `@unique` while a missing
> `email` attribute defaults to `""`, so the second attribute-less signup violates the constraint.
> Either one leaves a confirmed user with no citizen row, no error surfaced and no retry — and no
> HTTP route creates that row, so nothing else repairs it. Cases PC-01–PC-06 in
> `test/api-test/README.md` §14 are designed against this; the worker has no coverage yet.
>
> It is also the only publisher in `src/` that builds `new EventBridgeClient({})` with no endpoint
> override, so `EVENTBRIDGE_ENDPOINT` does not reach it — only the SDK's own
> `AWS_ENDPOINT_URL_EVENTBRIDGE` does. See [[Runbooks/Local_Testing]].

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
