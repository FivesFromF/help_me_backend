# HelpMe Hybrid Testing Guide (3 Services)

## Prerequisites

1. **AWS CLI & SSO/IAM**: Ensure you are logged in to AWS.
2. **SSM Plugin**: Install the [SSM Session Manager Plugin](https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-install-plugin.html) on your local machine.
3. **Go & Python**: Ensure Go 1.24+ and Python 3.10+ are installed.

---

## Step 1: Connect to Online RDS (SSM Tunnel)

Since RDS is private, you need to "tunnel" the connection through the Bastion host. Run this command in a separate terminal and **KEEP IT OPEN**:

```bash
# 1. Get Bastion Instance ID
# aws ec2 describe-instances --filters "Name=tag:Name,Values=helpme-bastion" --query "Reservations[*].Instances[*].InstanceId" --output text

# 2. Start the tunnel (Replace placeholders with actual values)
aws ssm start-session --target <BASTION_INSTANCE_ID> \
    --document-name AWS-StartPortForwardingSessionToRemoteHost \
    --parameters '{
        "host": ["<RDS_ENDPOINT>"],
        "portNumber": ["5432"],
        "localPortNumber": ["5433"]
    }'
```

The database will be available locally at `localhost:5433`.

---

## Step 2: Configure Environment

We have created `src/.env`. Open it and replace the following with your **Real AWS IDs**:
- `CORE_SYSTEM_BUS_NAME`
- `EMERGENCY_BUS_NAME`
- `COGNITO_USER_POOL_ID`
- `COGNITO_CLIENT_ID`

---

## Step 3: Run the Services

Open **three separate terminals** to run each service:

### Terminal A: Write Server (Go)
```bash
cd src
go run cmd/write-server/main.go
```
*Note: This server handles migrations for your local DB automatically.*

### Terminal B: Read Server (Go)
```bash
cd src
go run cmd/read-server/main.go
```

### Terminal C: AI Server (Python)
```bash
cd src/cmd/ai-server
# Install dependencies first
pip install -r requirements.txt
# Run the server
python main.py
```

---

## Step 4: Verification

1. **Health Check**: Visit `http://localhost:8080/health` (Write Server).
2. **AI Health**: Visit `http://localhost:8000/health`.
3. **App Connection**: Point your Flutter app's base URL to your local machine's IP (e.g., `http://192.168.1.X:8080`).

> [!IMPORTANT]
> Your local app will now send real events to your AWS EventBridge bus and interact with your real Cognito user pool!
