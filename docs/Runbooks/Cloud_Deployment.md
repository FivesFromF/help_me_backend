# Cloud Deployment Runbook

How the deployed stack is reached, how to ship to it, and the traps that cost a session to find.
`infra/` is real AWS; `local-infra/` is the emulator stack and is never deployed
(see [[Runbooks/Local_Testing]]).

Region is `ap-southeast-1`. First deployed 2026-08-22.

---

## 🌐 Reaching the API

| Entry point | Use |
| :-- | :-- |
| **`https://d24ebd8yyywrcs.cloudfront.net`** | **The API.** This is what clients call. |
| `http://helpme-alb-869389200.ap-southeast-1.elb.amazonaws.com` | The ALB — CloudFront's origin. Plain HTTP; do not ship it in an app. |

Both come from `terraform output` (`api_url`, `alb_dns_name`).

**CloudFront exists only to terminate TLS.** ACM will not issue a certificate for
`*.elb.amazonaws.com`, and this account owns no domain, so the ALB cannot serve HTTPS at all. The
default `*.cloudfront.net` name carries a trusted AWS certificate. Nothing is cached — the
distribution uses the managed `CachingDisabled` policy and forwards every request to the origin,
because responses are per-user medical data. `AllViewerExceptHostHeader` forwards `Authorization`
and the rest; without an origin request policy CloudFront would strip them.

`http://` on the CloudFront domain returns `301` to `https://`. The CloudFront → ALB hop is plain
HTTP inside AWS; putting an ACM certificate on the ALB is the follow-up once a domain exists.

### Path routing

The ALB routes by path (`modules/alb/main.tf`). **Deployed routes need the `/api/v1/…` prefix** —
the short `/api/…` form used by the test suite matches no rule and falls through to the default.

| Priority | Paths | Service |
| :-- | :-- | :-- |
| 10 | `/api/v1/write/*`, `/write-service/*`, `/api/v1/citizen/first-declare`, `/api/v1/citizen/medical-record/update`, `/api/v1/citizen/nfc/*` | write `:8080` |
| 20 | `/api/v1/read/*`, `/read-service/*`, `/api/v1/scan*`, `/api/v1/victim/*`, `/api/v1/citizen/*` | read `:8081` |

Write rules are evaluated first so `/api/v1/citizen/first-declare` is not swallowed by the read
service's broader `/api/v1/citizen/*`.

---

## 🗄️ Database topology

One `db.t4g.micro` PostgreSQL instance, **Multi-AZ with a single standby**, `backup_retention_period = 7`.

**The standby is not readable.** It serves no queries and exists only for automatic failover
(~60–120s). Both servers therefore share one endpoint — the write server and the read server point
at the same primary. Only a Multi-AZ DB *cluster* (three instances) has readable standbys.

A read replica was built and then removed on 2026-08-22 in favour of Multi-AZ: availability beat
read offload, since one 0.25-vCPU read task never came close to saturating the primary, and a
single-AZ database was a whole-platform outage risk. Cost is the same either way — both run a second
instance. Consequence worth keeping: **there is no replication lag**, so write-then-immediately-read
is consistent.

If a replica is ever reintroduced, the read server can point at it with no code change — each
service is its own process and reads its own `DATABASE_URL` — but only because the read server
issues **no** Postgres writes (its writes go to DynamoDB). Verify that still holds before splitting
the endpoints again, or it will fail with `cannot execute INSERT in a read-only transaction`.

Migrations always target the primary.

---

## 🚀 Deploying

```bash
# 1. Lambda zips - Terraform consumes checked-in artifacts, so this must run first
npm run build                     # prisma generate && tsc && node build.js

# 2. Service images
aws ecr get-login-password --region ap-southeast-1 \
  | docker login --username AWS --password-stdin 915742579310.dkr.ecr.ap-southeast-1.amazonaws.com

REG=915742579310.dkr.ecr.ap-southeast-1.amazonaws.com
docker build -f src/services/write-server/Dockerfile -t $REG/helpme-backend:write-latest .
docker build -f src/services/read-server/Dockerfile  -t $REG/helpme-backend:read-latest  .
docker build -f src/services/ai-server/Dockerfile    -t $REG/helpme-ai-server:latest src/services/ai-server
docker push $REG/helpme-backend:write-latest && docker push $REG/helpme-backend:read-latest
docker push $REG/helpme-ai-server:latest      # ~3.2 GB - torch, mediapipe and the model weights

# 3. Infrastructure
cd infra && terraform plan -out=tfplan && terraform apply tfplan
```

`scripts/deploy.ps1 -Target all|write|read|ai|<lambda-name>` wraps step 2, and
`scripts/cloud-start.ps1` / `cloud-stop.ps1` wake and sleep the ECS services, RDS and the bastion.

**Terraform creates both ECR repositories** — `helpme-backend` in `modules/ecs/main.tf:2` and
`helpme-ai-server` in `modules/ai_service/main.tf`. Do not create them by hand; that causes an
`EntityAlreadyExists` collision on apply.

### State backend

`providers.tf` uses an S3 backend (`helpme-terraform-state-xyz`) with a DynamoDB lock table
(`helpme-terraform-locks-xyz`). **Terraform cannot create its own backend** — both were bootstrapped
by hand with `aws s3api create-bucket` and `aws dynamodb create-table`. If `terraform init` reports
the bucket does not exist, recreate them before anything else.

---

## ⚠️ Traps

> **`.env` shadows your real AWS credentials.** `.env` sets `AWS_ACCESS_KEY_ID=test` /
> `AWS_SECRET_ACCESS_KEY=test` for the local emulators, which accept any key. Environment variables
> outrank `~/.aws/credentials` in the SDK chain, so any shell that inherited `.env` fails every real
> AWS call with `InvalidClientTokenId` — `aws`, `terraform` and `docker push` alike. Clear them for
> the session, or prefix each command:
>
> ```bash
> env -u AWS_ACCESS_KEY_ID -u AWS_SECRET_ACCESS_KEY terraform plan
> ```
>
> Confirm with `aws sts get-caller-identity` before blaming your credentials. Same family as the
> `.env` traps in [[Runbooks/Local_Testing]].

> **IAM survives a regional teardown.** Deleting the stack's regional resources leaves IAM roles and
> policies behind — IAM is global, so a region-scoped sweep of ECS/Lambda/RDS/ECR/Cognito/DynamoDB
> does not show them. They then collide with the next apply as `EntityAlreadyExists`. Check with
> `aws iam list-roles --query 'Roles[?starts_with(RoleName,\`helpme\`)].RoleName'`. **Prefer
> `terraform import` over deleting** — Terraform adopts the identity and updates it in place. The
> same applies to EventBridge buses and ECR repositories.

> **The read server needs `PORT=8080` in its task definition.** `read-server/index.ts:13` defaults to
> **8081**, but its `portMappings` and ALB target group both use 8080. Without the env var the
> container listens on the wrong port, every health check fails with `Target.FailedHealthChecks`, and
> the ALB answers **502**. The write server needs no such line — its default already is 8080.

> **CloudFront managed-policy IDs must be looked up, not remembered.** A wrong id fails the apply
> with `NoSuchOriginRequestPolicy`. Get them from
> `aws cloudfront list-origin-request-policies --type managed` and `list-cache-policies --type managed`.

> **RDS rejects overlapping modifications.** Destroying a replica and modifying the primary in one
> apply fails with `InvalidDBInstanceState: Database instance is not in available state`. Wait for
> `available` and re-apply; Terraform is not aware of the constraint.

> **`terraform apply` output is ANSI-coloured**, so grepping it for `Creation complete` silently
> returns nothing. `terraform state list | wc -l` is the honest progress check.

---

## 📉 Known capacity limits

The stack is sized for demonstration, not load. As of 2026-08-22:

| | Value |
| :-- | :-- |
| ECS autoscaling | **none** — no scalable targets exist |
| Tasks per service | **1** (`desired_count = 1`) |
| Task size | 0.25 vCPU / 512 MB |
| RDS `max_connections` | ~112 (`LEAST(DBInstanceClassMemory/9531392, 5000)` on 1 GiB) |

A single task restart is a **full outage** for that service; Multi-AZ protects only the database.
Before scaling out, pin the pool in `DATABASE_URL` (`?connection_limit=5&pool_timeout=10`): Prisma
defaults to `num_cpus * 2 + 1`, and in Fargate `os.cpus()` reports the *host's* CPU count rather
than the task's share, so added tasks exhaust database connections before they exhaust CPU.

**Cloud Map is configured but unused.** The `helpme.local` namespace and the two
`aws_service_discovery_service` registrations cost roughly $0.70/month (a Route53 private hosted
zone plus $0.10 per registered task, which grows with autoscaling). Nothing in `src/` resolves it —
the services make no synchronous calls to each other: write and read coordinate through EventBridge
([[Architecture/EventBridge_Sync]]) and the AI service is an SQS consumer with no HTTP surface
([[Services/AI_Server]]).
