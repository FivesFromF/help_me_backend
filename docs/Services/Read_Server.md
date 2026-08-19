# Read Server Service

- **Runtime**: Node.js 20+ / TypeScript
- **Port**: `8081` (or `PORT` environment variable)
- **Start Script**: `npm run start:read` (there is no `dev:read` watch script)
- **Entry Point**: `src/services/read-server/index.ts`

---

## Key Responsibilities

1. **Emergency Identifier Resolving**: Fast lookup of citizen basic medical profiles when an NFC tag or QR token is scanned.
2. **Citizen Read Access**: Fetches patient records and emergency contact details for authorized requests.
3. **Optimized Queries**: Direct read projections preventing mutation overhead on write pipelines.
