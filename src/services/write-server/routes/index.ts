import { Router } from "express";
import { healthRoutes } from "./health.routes";
import { citizenRoutes } from "./citizen.routes";
import { nfcRoutes } from "./nfc.routes";
import { qrRoutes } from "./qr.routes";
import { accessRoutes } from "./access.routes";
import { emergencyRoutes } from "./emergency.routes";
import { uploadRoutes } from "./upload.routes";

export const writeRouter = Router();

// 1. Health Probe
writeRouter.use(healthRoutes);

// 2. Feature Domain Routes
writeRouter.use(citizenRoutes);
writeRouter.use(nfcRoutes);
writeRouter.use(qrRoutes);
writeRouter.use(accessRoutes);
writeRouter.use(emergencyRoutes);
writeRouter.use(uploadRoutes);

export default writeRouter;
