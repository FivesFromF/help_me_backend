import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import dotenv from "dotenv";
import { readRouter } from "./routes";
import { authenticate } from "../../shared/middleware/auth";
import { prisma } from "../../shared/db";

dotenv.config();

const app = express();
const PORT = parseInt(process.env.PORT || "8081", 10);

app.use(helmet());
app.use(cors());
app.use(morgan("combined"));
app.use(express.json({ limit: "15mb" }));
app.use(express.urlencoded({ extended: true, limit: "15mb" }));

// Authentication middleware (reads X-Cognito-Id/X-Role or Authorization Bearer)
app.use(authenticate);

// Mount read routes
app.use(readRouter);

// Global Error Handler
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error("[read-server] Unhandled Error:", err);
  res.status(500).json({ error: err.message || "Internal Server Error" });
});

const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 HelpMe Read Service running on http://0.0.0.0:${PORT}`);
});

const shutdown = async () => {
  console.log("Shutting down read-server...");
  server.close(async () => {
    await prisma.$disconnect();
    console.log("Read server closed.");
    process.exit(0);
  });
};

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

export default app;
