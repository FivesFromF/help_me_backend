# Write Server Service

- **Runtime**: Node.js 20+ / TypeScript
- **Port**: `8080` (or `PORT` environment variable)
- **Start Script**: `npm run start:write` or `npm run dev:write`
- **Entry Point**: `src/services/write-server/index.ts`

---

## Key Responsibilities

1. **Authentication Middleware**: Validates JWTs issued by AWS Cognito (`aws-jwt-verify`).
2. **Citizen Profiles**: Handles initial registration completion, CCCD updates, and consent regulation.
3. **Medical Record Mutations**: Writes updates to blood type, allergies, medications, and conditions.
4. **Hardware Association**: Registers and links physical NFC tags and QR codes to citizen records.
5. **Event Emission**: Dispatches messages to AWS EventBridge (`CORE_SYSTEM_BUS_NAME` and `EMERGENCY_BUS_NAME`).
