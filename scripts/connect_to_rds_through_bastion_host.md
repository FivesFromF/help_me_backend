# Connecting to RDS through the bastion host

The database sits in private subnets with no public address. Nothing reaches it directly — not
`psql`, not Prisma Studio, not a GUI client. The bastion is an EC2 instance inside the VPC that
AWS Systems Manager can port-forward through, so `localhost:<port>` on your machine becomes port
5432 on RDS.

No SSH key and no open inbound port are involved: Session Manager tunnels over the SSM API, which is
why the bastion's security group needs no ingress rule at all.

## Before you start

1. **Session Manager plugin** installed alongside the AWS CLI — the `start-session` command fails
   with `SessionManagerPlugin is not found` without it.
   [Install guide](https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-install-plugin.html)
2. **The bastion and RDS must be awake.** `./scripts/cloud-start.ps1` starts both; RDS takes 3–5
   minutes to leave `starting`. A stopped bastion gives you `TargetNotConnected`.
3. **Your IAM principal needs `ssm:StartSession`** on the instance and the
   `AWS-StartPortForwardingSessionToRemoteHost` document.
4. **Clear the emulator credentials first.** `.env` sets `AWS_ACCESS_KEY_ID=test` for the local
   stack, and environment variables outrank `~/.aws/credentials` in the SDK chain — any shell that
   inherited them fails with `InvalidClientTokenId`:

   ```powershell
   $env:AWS_ACCESS_KEY_ID = $null; $env:AWS_SECRET_ACCESS_KEY = $null; $env:AWS_SESSION_TOKEN = $null
   ```
   ```bash
   env -u AWS_ACCESS_KEY_ID -u AWS_SECRET_ACCESS_KEY -u AWS_SESSION_TOKEN <command>
   ```

   Confirm with `aws sts get-caller-identity` before blaming anything else.

## Open the tunnel

Read the instance id and endpoint from Terraform rather than pasting someone else's — they differ in
every account, and the bastion is replaced whenever it is rebuilt.

**PowerShell**

```powershell
$BastionId   = terraform -chdir=infra output -raw bastion_instance_id
$RdsEndpoint = terraform -chdir=infra output -raw rds_endpoint

aws ssm start-session `
  --target $BastionId `
  --document-name AWS-StartPortForwardingSessionToRemoteHost `
  --parameters "host=$RdsEndpoint,portNumber=5432,localPortNumber=5433"
```

**bash**

```bash
BASTION_ID=$(terraform -chdir=infra output -raw bastion_instance_id)
RDS_ENDPOINT=$(terraform -chdir=infra output -raw rds_endpoint)

aws ssm start-session \
  --target "$BASTION_ID" \
  --document-name AWS-StartPortForwardingSessionToRemoteHost \
  --parameters "host=$RDS_ENDPOINT,portNumber=5432,localPortNumber=5433"
```

> [!important] Use **5433** locally, not 5432.
> `docker compose up -d db` already binds 5432 on your machine. Forwarding onto the same port either
> fails outright or — worse — appears to work while your client talks to the local container. Every
> query then returns local seed data and you conclude production is fine. 5433 keeps them apart.

Leave the session running; it holds the tunnel open. `Ctrl+C` closes it.

## Use the tunnel

In a second terminal, point the connection string at the forwarded port. The username and database
name come from your own `terraform.tfvars` (`db_password`) and the RDS module — the defaults in this
repo are user `adminuser`, database `helpme`:

```bash
psql "postgresql://adminuser:<password>@localhost:5433/helpme"
```

Prisma tools work the same way, without touching `.env`:

```bash
DATABASE_URL="postgresql://adminuser:<password>@localhost:5433/helpme" npx prisma studio
```

Verifying a deployed migration is the most common reason to open this tunnel. Code and database are
deployed by different hands here and have drifted more than once, and Prisma selects every scalar
column when a query has no explicit `select` — so one missing column breaks *every* read of that
table, not just the feature that added it:

```sql
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'citizens'
ORDER BY ordinal_position;
```

## When it does not work

| Symptom | Cause |
| :-- | :-- |
| `TargetNotConnected` | Bastion stopped, or its SSM agent has not registered yet. Run `cloud-start.ps1`, wait a minute. |
| `InvalidClientTokenId` | `.env` credentials in the shell. See step 4. |
| `SessionManagerPlugin is not found` | Plugin missing; the AWS CLI alone is not enough. |
| Tunnel opens, `psql` hangs | RDS still `starting`, or you forwarded onto a port already in use. |
| Connects but the data looks local | You used 5432 and reached the Docker container. |
| `no pg_hba.conf entry` | Reached a different database — check the endpoint came from `terraform output`. |

## Forking this repo

Nothing here is specific to one account: both identifiers come from `terraform output`, so the
commands work as-is once `terraform apply` has created your own stack. What you must supply yourself
is `infra/terraform.tfvars` (gitignored — `db_password`, Cognito and Google values) and the S3 state
bucket plus DynamoDB lock table named in `infra/providers.tf`, which Terraform cannot create for
itself. See [[Runbooks/Cloud_Deployment]].
