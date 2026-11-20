import { t } from "./core/errors.js";
import express from "express";
import { env } from "./config/env.js";
import { db } from "./core/db.js";
import { correlation, errorHandler, notFoundHandler } from "./core/http.js";
import { securityHeaders } from "./core/security.js";
import { accessRouter } from "./modules/access/access.routes.js";
import { identityRouter } from "./modules/identity/identity.routes.js";
import { clientRouter } from "./modules/canada/client.routes.js";
import { financeRouter } from "./modules/canada/finance/finance.routes.js";
import { flightRouter } from "./modules/canada/flights/flight.routes.js";
import { operationsRouter } from "./modules/canada/operations.routes.js";
import { parcelRouter } from "./modules/canada/parcels/parcel.routes.js";
import { shipmentRouter } from "./modules/canada/shipments/shipment.routes.js";
import { structureRouter } from "./modules/canada/structure.routes.js";
import { governanceRouter } from "./modules/access/governance.routes.js";
import { settingsRouter } from "./modules/canada/settings.routes.js";
import { logisticsExtraRouter } from "./modules/canada/logistics.extra.routes.js";
import { clientSelfRouter } from "./modules/canada/client.self.routes.js";
import { exportsRouter } from "./modules/canada/exports.routes.js";
import { documentsRouter } from "./modules/canada/documents.routes.js";
import { supportRouter } from "./modules/canada/support.routes.js";
import { resendWebhookRaw } from "./modules/notifications/webhooks.js";

let built: express.Express | null = null;

export function createApp() {
  if (built) return built;
  const e = env();
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", e.TRUST_PROXY ? 1 : false);
  app.use(correlation);
  app.use(securityHeaders);

  const origins = e.CORS_ORIGINS.split(",").map((o) => o.trim()).filter(Boolean);
  app.use((req, res, next) => {
    const origin = req.header("origin");
    if (origin && origins.includes(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, Idempotency-Key, X-Correlation-Id");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
      res.setHeader("Access-Control-Expose-Headers", "X-Correlation-Id, Idempotent-Replayed");
    }
    if (req.method === "OPTIONS") return res.sendStatus(origin && origins.includes(origin) ? 204 : 403);
    next();
  });
  // Webhook avant express.json : la signature porte sur le corps BRUT.
  app.post("/api/v1/webhooks/resend", ...resendWebhookRaw);
  app.use(express.json({ limit: "1mb" }));

  app.get("/api/v1/health", async (_req, res) => {
    try {
      await db.query("select 1");
      res.json({ success: true, data: { status: "ok", database: "ok" } });
    } catch {
      res.status(503).json({ success: false, error: { code: "DATABASE_UNAVAILABLE", message: t("Base de données indisponible."), details: [] } });
    }
  });

  const v1 = express.Router();
  v1.use(identityRouter());
  v1.use(accessRouter());
  v1.use(governanceRouter());
  v1.use(settingsRouter());
  v1.use(structureRouter());
  v1.use(logisticsExtraRouter());
  v1.use(exportsRouter());
  v1.use(parcelRouter());
  v1.use(shipmentRouter());
  v1.use(flightRouter());
  v1.use(financeRouter());
  v1.use(operationsRouter());
  v1.use(clientRouter());
  v1.use(clientSelfRouter());
  v1.use(documentsRouter());
  v1.use(supportRouter());
  app.use("/api/v1", v1);

  app.use(notFoundHandler);
  app.use(errorHandler);
  built = app;
  return app;
}
