# HelpMe Backend — Knowledge Base

Welcome to the **HelpMe Emergency Assistance & Healthcare Identification** backend documentation vault.

---

## 🎯 System Mission

The HelpMe platform provides real-time emergency healthcare identification, citizen medical records, NFC/QR emergency access, and emergency incident dispatching with AI-driven face recognition and OCR verification.

---

## 🏗️ Architecture Summary

The backend uses a **CQRS (Command Query Responsibility Segregation)** pattern decoupled across three primary service layers and serverless event-driven workers:

1. **Write Server (`Node.js/Express`)**: Port `8080` — Handles mutations, authentication validation, writes to PostgreSQL (via Prisma), and publishes domain events to AWS EventBridge.
2. **Read Server (`Node.js/Express`)**: Port `8081` — High-performance read operations, queries, and emergency medical lookups (NFC, QR, Citizen search).
3. **AI Service (`Python Worker`)**: Dedicated SQS Consumer — Face embedding generation (512-d vectors via `pgvector`) and biometric facial recognition.
4. **Asynchronous Event Workers (`AWS Lambda`)**:
   - `post-confirmation`: Initializes citizen profile upon Cognito registration.
   - `audit-worker`: Immutable audit trail logging.
   - `notification-worker`: Real-time dispatching and email/SMS alerts.
   - `grant-permission-worker`: Temporary emergency healthcare access grants.

---

## 🗺️ Quick Navigation

- [[Architecture/CQRS_Pattern|CQRS Pattern & Data Flow]]
- [[Architecture/Database_Schema|Database Schema & Prisma Models]]
- [[Architecture/EventBridge_Sync|EventBridge & Async Lambda Sync]]
- [[Architecture/Authentication_and_Audit|Authentication Middleware & Platform Audit Trail]]
- [[Architecture/System_Architecture.canvas|Interactive Architecture Map (Canvas)]]
- [[Architecture/Infra_Architecture.canvas|Interactive Infrastructure Architecture Map (Canvas)]]
- [[Services/Write_Server|Write Server (Port 8080)]]
- [[Services/Read_Server|Read Server (Port 8081)]]
- [[Services/AI_Server|AI Service (SQS Worker)]]
- [[Runbooks/Local_Testing|Local Development & Emulation Guide]]
