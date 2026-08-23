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

One `db.t4g.micro` PostgreSQL instance, **Multi-AZ with a single standby**, `backup_retention_period = 7`,
**encrypted at rest** with the AWS-managed `aws/rds` key (`ap-southeast-1a` primary, `1b` standby).

**The standby is not readable.** It serves no queries and exists only for automatic failover
(~60–120s). Both servers therefore share one endpoint — the write server and the read server point
at the same primary. Only a Multi-AZ DB *cluster* (three instances) has readable standbys.

### Encrypting RDS at rest

`storage_encrypted = true` with no `kms_key_id`, i.e. the AWS-managed `aws/rds` key. S3, DynamoDB
and SQS were already encrypted by their service defaults; RDS was the one store holding medical
records, CCCD numbers and face embeddings in the clear.

> [!danger] Never flip this flag with `terraform apply` on a live instance.
> `storage_encrypted` is ForceNew — Terraform destroys the instance and creates an **empty** one.
> AWS offers no in-place toggle. `lifecycle { prevent_destroy = true }` on `aws_db_instance.main`
> turns that plan into `Error: Instance cannot be destroyed` instead of a silent data loss, and
> `skip_final_snapshot` is now `false`. Both stay after the migration; they are the guard, not a
> temporary measure.

The migration is manual: snapshot → copy **with** encryption → restore → swap identifiers. Encryption
is applied by the *copy*, which is the only step that can introduce it.

```bash
for s in write read ai; do
  aws ecs update-service --cluster helpme-cluster --service helpme-$s-service --desired-count 0
done

aws rds create-db-snapshot --db-instance-identifier helpme-db \
  --db-snapshot-identifier helpme-db-preenc
aws rds wait db-snapshot-completed --db-snapshot-identifier helpme-db-preenc

aws rds copy-db-snapshot \
  --source-db-snapshot-identifier helpme-db-preenc \
  --target-db-snapshot-identifier helpme-db-enc \
  --kms-key-id alias/aws/rds
aws rds wait db-snapshot-completed --db-snapshot-identifier helpme-db-enc

aws rds restore-db-instance-from-db-snapshot \
  --db-instance-identifier helpme-db-new \
  --db-snapshot-identifier helpme-db-enc \
  --db-instance-class db.t4g.micro \
  --db-subnet-group-name helpme-db-private-subnet-group \
  --vpc-security-group-ids sg-0af615206dae78bfc \
  --multi-az --no-publicly-accessible
aws rds wait db-instance-available --db-instance-identifier helpme-db-new

# Swap: the endpoint hostname follows the identifier
aws rds modify-db-instance --db-instance-identifier helpme-db \
  --new-db-instance-identifier helpme-db-old --apply-immediately
aws rds wait db-instance-available --db-instance-identifier helpme-db-old
aws rds modify-db-instance --db-instance-identifier helpme-db-new \
  --new-db-instance-identifier helpme-db --apply-immediately
aws rds wait db-instance-available --db-instance-identifier helpme-db
```

**Why the rename rather than repointing `DATABASE_URL`.** The endpoint is
`<identifier>.<account-hash>.<region>.rds.amazonaws.com` and the hash is fixed per account and
region, so renaming the restored instance to `helpme-db` reproduces the exact hostname already in
every task definition and in `.env`. Master username and password survive the snapshot, so there is
no credential rotation either. No application code, no task definition and no redeploy is involved —
encryption at rest is invisible above the storage layer.

> [!important] The rename does **not** carry Terraform state with it.
> `aws_db_instance` is keyed in state by `DbiResourceId`, not by identifier, so after the swap state
> still points at the **old, unencrypted** instance. The next plan then reads
> `storage_encrypted = false -> true # forces replacement` and tries to destroy your database —
> which is what `prevent_destroy` exists to stop. Re-point state at the new instance:
>
> ```bash
> terraform state rm module.rds.aws_db_instance.main
> terraform import module.rds.aws_db_instance.main helpme-db   # import takes the identifier
> terraform plan -target=module.rds.aws_db_instance.main       # now in-place drift only
> ```
>
> `state rm` changes nothing in AWS — it only makes Terraform forget the resource.

What remains after the import is harmless in-place drift the restore introduced:
`max_allocated_storage 0 -> 100`, missing tags, and config-only fields (`apply_immediately`,
`skip_final_snapshot`, `final_snapshot_identifier`, `password`).

Afterwards, restore the backup window if the restore reset it (it may carry over), then clean up —
the old instance bills
until deleted:

```bash
aws rds modify-db-instance --db-instance-identifier helpme-db \
  --backup-retention-period 7 --apply-immediately
aws rds delete-db-instance --db-instance-identifier helpme-db-old --skip-final-snapshot
aws rds delete-db-snapshot --db-snapshot-identifier helpme-db-preenc
```

Bring the three ECS services back to `desired-count 1`, or run `./scripts/cloud-start.ps1`.

**Security-group rules must all be standalone, never inline.** `aws_security_group.rds` declares no
`ingress`/`egress` blocks; every rule is its own `aws_security_group_rule`. Mixing the two styles is
not a preference — an inline block is treated as the *complete* rule set, so each apply deletes any
rule declared elsewhere, including `aws_security_group_rule.ai_tasks_to_rds` in `infra/main.tf`. That
silently cuts the AI worker off from Postgres again. The AI rule cannot move inline: `modules/rds`
would then depend on `modules/ai_service`, which already depends on `rds` for the endpoint.

Converting existing inline rules means importing them, since they already exist in AWS and a plain
apply hits `InvalidPermission.Duplicate`. The id format is `<sg-id>_<type>_<protocol>_<from>_<to>_<source>`,
with `all` for protocol `-1`:

```bash
terraform import 'module.rds.aws_security_group_rule.app_tasks_to_rds' 'sg-…_ingress_tcp_5432_5432_sg-…'
terraform import 'module.rds.aws_security_group_rule.rds_egress'       'sg-…_egress_all_0_0_0.0.0.0/0'
```

**Verifying it is real.** `StorageEncrypted` is not a self-reported preference — encryption is a
property of the underlying volumes, fixed at creation, which is exactly why it cannot be toggled in
place. The behavioural proof is that a later **automated** snapshot comes out `Encrypted: true` with
no `--kms-key-id` passed:

```bash
aws rds describe-db-snapshots --query "DBSnapshots[?SnapshotType=='automated'].[DBSnapshotIdentifier,Encrypted]" --output text
aws kms describe-key --key-id <KmsKeyId> --query "KeyMetadata.[KeyManager,KeyState]" --output text  # AWS / Enabled
```

Encryption is **not retroactive**: automated snapshots taken before the migration stay unencrypted
until the 7-day retention expires or the old instance is deleted, and a *manual* snapshot never
expires at all — it survives instance deletion and bills until explicitly removed. The pre-migration
manual snapshot is a plaintext copy of medical records; deleting it is a privacy step, not tidying.

### Where the data physically lives

Everything is in **`ap-southeast-1` — Singapore**. RDS (medical records, CCCD, face embeddings), both
S3 buckets, DynamoDB, and the KMS key. So Vietnamese citizens' biometric and health data — both
"sensitive personal data" under PDPD Decree 13/2023 — is stored outside Vietnam, which the decree
treats as a cross-border transfer with its own assessment and notification obligations. AWS has no
Vietnam region, so the options are a local provider, on-premises, or the transfer paperwork. Worth
knowing before anyone calls this production-ready.

Two scope facts that follow from it:

- **KMS keys are regional.** `alias/aws/rds` exists only in `ap-southeast-1`, and an AWS-managed key
  cannot be shared across regions — so an encrypted snapshot copied to another region for DR cannot
  be restored there. Cross-region DR is the one concrete argument for a customer-managed key.
- **S3 bucket names are global, data is regional.** `helpme-avatars-mndkh` and
  `helpme-terraform-state-xyz` carry suffixes because the namespace is worldwide. A fork cannot reuse
  them: `modules/s3` generates a `random_suffix` for the avatars bucket, but the state bucket in
  `providers.tf` is hardcoded and has to be renamed by hand.

**What this does and does not buy.** It defends against a stolen disk or a snapshot shared to the
wrong account. It does nothing about a leaked password, an over-broad IAM role, or a bug returning
the wrong citizen's record — the application sees plaintext by design. `DATABASE_URL` still sits in
plaintext in the ECS task definitions, readable via `ecs:DescribeTaskDefinition`; moving it to
Secrets Manager is the larger real-world win and is still outstanding.

A read replica was built and then removed on 2026-08-22 in favour of Multi-AZ: availability beat
read offload, since one 0.25-vCPU read task never came close to saturating the primary, and a
single-AZ database was a whole-platform outage risk. Cost is the same either way — both run a second
instance. Consequence worth keeping: **there is no replication lag**, so write-then-immediately-read
is consistent.

**A replica can no longer simply be reintroduced.** That option rested on the read server issuing no
Postgres writes, which stopped being true on 2026-08-22: `scan.routes.ts` now writes the access
grant itself (`access_sessions`), because the Lambda that used to do it cannot reach RDS from
outside the VPC. Pointing the read server at a read-only replica today fails with
`cannot execute INSERT in a read-only transaction` on every successful scan. Splitting the endpoints
again means routing that one write back to the primary first.

Migrations always target the primary.

---

## 🚀 Deploying

```bash
# 1. Lambda zips - Terraform reads them off disk and git does not track them, so this must run first
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

> **`terraform apply` cannot deploy Lambda code.** Every function declares
> `lifecycle { ignore_changes = [filename] }` and no `source_code_hash`, so an apply reports success
> and leaves the old code running - silently. Ship Lambda changes with the CLI:
>
> ```bash
> aws lambda update-function-code --function-name helpme-post-confirmation --zip-file fileb://infra/modules/lambda/post_confirmation.zip --region ap-southeast-1
> ```
>
> `scripts/deploy.ps1` wraps this. Rebuild the zips with `npm run build` first.

> **Check the production schema before deploying a migration-bearing change.** Code and database are
> deployed by different hands here, and they have drifted twice. Prisma selects every scalar column
> when a query has no explicit `select`, so one missing column breaks *every* read of that table -
> not only the feature that added it. A tunnelled `information_schema.columns` query takes seconds
> and is worth doing even when the migration is believed to be applied.

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

> **Both Windows shells mangle CLI arguments, in different ways.** In Git Bash, MSYS path conversion
> rewrites any value that looks like a Unix path: `/ecs/helpme-ai` reaches the AWS CLI as a Windows
> path and fails the log-group name constraint
> (`failed to satisfy constraint: [\.\-_/#A-Za-z0-9]+`), and CIDRs inside security-group-rule import
> ids break the same way. Prefix the command with `MSYS_NO_PATHCONV=1`. In PowerShell, an unquoted
> `-target=aws_security_group_rule.x` is split on the `.`, and Terraform then reports
> `Invalid target "aws_security_group_rule"` — quote the whole token. Note also that `!` in the
> Claude Code prompt runs **bash**, so `$env:VAR=$null` there is a silent no-op; bash needs `env -u`.

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
