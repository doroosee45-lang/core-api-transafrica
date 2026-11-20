import "dotenv/config";
import { loadEnv } from "./config/env.js";
import { createApp } from "./app.js";
import { closePool } from "./core/db.js";
import { startWorker, stopWorker } from "./modules/notifications/worker.js";

const e = loadEnv();
const server = createApp().listen(e.PORT, () => {
  console.log(`Trans Afrique Core API — port ${e.PORT} — environnement ${e.NODE_ENV}`);
});
startWorker();

const shutdown = async () => {
  stopWorker();
  server.close();
  await closePool();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
