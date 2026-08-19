import { Router } from "express";
import { healthRoutes } from "./health.routes";
import { citizenRoutes } from "./citizen.routes";
import { scanRoutes } from "./scan.routes";
import { victimRoutes } from "./victim.routes";

export const readRouter = Router();

// 1. Health Probe
readRouter.use(healthRoutes);

// 2. Feature Domain Routes
readRouter.use(citizenRoutes);
readRouter.use(scanRoutes);
readRouter.use(victimRoutes);

export default readRouter;
