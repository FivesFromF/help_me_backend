# Code Layout & Build Topology

How the repository's directories map onto the four things that actually deploy. For *what* each
service does, see [[Services/Write_Server]], [[Services/Read_Server]] and [[Services/AI_Server]];
this page is about where the code lives and how it is built.

---

## 🧩 One tree, four deployables

`src/` is a single TypeScript project (one `tsconfig.json`, one Prisma client, one `src/shared/`)
that produces several independently deployed artifacts:

| Path | Deployable | Built by |
| :-- | :-- | :-- |
| `src/services/write-server/` | Express API on `:8080` | `tsc` (`npm run build:server`) + its own `Dockerfile` |
| `src/services/read-server/` | Express API on `:8081` | `tsc` + its own `Dockerfile` |
| `src/services/ai-server/` | Python SQS consumer | `requirements.txt` / `Dockerfile` — **not** touched by npm |
| `src/functions/*/handler.ts` | AWS Lambdas | `node build.js` (esbuild → zip) |

The two Express servers are the CQRS pair: writes go to Postgres and publish to EventBridge, reads
never mutate. See [[Architecture/CQRS_Pattern]].

`src/shared/` is what makes this one tree rather than four repos — `db/` (Prisma client),
`middleware/auth.ts` (see [[Architecture/Authentication_and_Audit]]), and `services/`
(`ai`, `events`, `hash`, `job`, `s3`). A change here reaches every deployable at once.

---

## 📦 The Lambda build (`build.js`)

`node build.js` bundles each `src/functions/<name>/handler.ts` with esbuild, zips it, and copies the
zip into **`infra/modules/lambda/`** (the `authorizer` also goes to `infra/modules/authorizer/`).
Terraform in `infra/` consumes the zips from there — so a Terraform apply against a stale zip is a
silent deploy of old code. Always `npm run build` before applying.

`build.js` declares five functions, but only four handler directories exist: `audit-worker`,
`grant-permission-worker`, `notification-worker`, `post-confirmation`. The fifth, `authorizer`, is
skipped at build time by an `fs.existsSync` guard — its entry is a leftover, not a missing file.

Note the script split: `npm run build:server` is `tsc` alone and produces **no** Lambda zips and
**no** Prisma client; `npm run build` is `prisma generate && tsc && node build.js`.

---

## 🧪 What is dev-only

- **`local-infra/`** — a Serverless-offline stack emulating S3, DynamoDB, SQS and EventBridge, each
  on its own port. It is development scaffolding and is never deployed; the real resources come from
  `infra/` (Terraform). Details in [[Runbooks/Local_Testing]].
- **`docker-compose.yaml`** — `db`, `dynamodb`, `dynamodb-init`, plus optional `ai-server`,
  `write-server`, `read-server` images. Containers do not receive `SKIP_AUTH`, so they enforce real
  authentication where the in-process test suite bypasses it.
- **`test/`** — `api-test/` (tsx, in-process routers) and `ai-test/` (Python). See
  [[Services/API_Reference_and_Tests]].

---

## ⚠️ Events are best-effort

Publishing to EventBridge is fire-and-forget: a dead or misconfigured endpoint logs
`[events] failed to publish` and **never changes an HTTP status**. The entire asynchronous path —
audit trail, notifications, permission grants — can therefore be dead while every API test still
passes. When debugging "the worker never ran", check the publish warnings before the worker.
See [[Architecture/EventBridge_Sync]].
