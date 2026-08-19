# Local Testing & Development Runbook

Run and test all 3 backend services and PostgreSQL database locally.

---

## 🛠️ Step 1: Database Setup

### Option A: Local Docker PostgreSQL
```bash
docker compose up db -d
npm run prisma:generate
npm run db:push
npm run db:seed
```

### Option B: Remote RDS Bastion Tunnel
```bash
aws ssm start-session --target <BASTION_INSTANCE_ID> \
    --document-name AWS-StartPortForwardingSessionToRemoteHost \
    --parameters '{
        "host": ["<RDS_ENDPOINT>"],
        "portNumber": ["5432"],
        "localPortNumber": ["5433"]
    }'
```

---

## 🚀 Step 2: Start Services

Open three terminals:

1. **Write Server**:
   ```bash
   npm run dev:write
   ```
2. **Read Server**:
   ```bash
   npm run dev:read
   ```
3. **AI Server**:
   ```bash
   cd src/services/ai-server
   pip install -r requirements.txt
   python main.py
   ```

---

## 🩺 Step 3: Health Checks

- Write Server: `http://localhost:8080/health`
- Read Server: `http://localhost:8081/health`
- AI Server: `http://localhost:8000/health`
