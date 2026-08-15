/** Application server: API + static frontend (production). */
import express from "express";
import fs from "node:fs";
import path from "node:path";
import { getDb, initSchema, APP_ROOT, DB_PATH } from "./db.js";
import { createApi } from "./api.js";
import { createStandardizeApi } from "./standardize/api.js";
import { createTitleApi } from "./title/api.js";
import { loadConfig, CONFIG_FILE_PATH } from "./config.js";
import { securityHeaders, corsPolicy, authGuard, csrfGuard,
  bindingSummary } from "./security/http.js";
import { runStartupRecovery } from "./recovery.js";
import { applyRetentionPolicy } from "./retention.js";

const cfg = loadConfig();
const db = getDb();
initSchema(db);

// crash recovery + retention housekeeping before serving any request
const recovery = runStartupRecovery(db);
if (recovery.staleProcessing || recovery.temporaryFilesRemoved.length) {
  console.log(`[recovery] stale processing jobs: ${recovery.staleProcessing} `
    + `(resumable ${recovery.resumable}, unrecoverable ${recovery.unrecoverable}); `
    + `temporary files removed: ${recovery.temporaryFilesRemoved.length}`);
}
const retention = applyRetentionPolicy(db);
if (retention.purgedProjects.length) {
  console.log(`[retention] purged ${retention.purgedProjects.length} project(s) by policy`);
}

const app = express();
app.disable("x-powered-by");
app.use(securityHeaders);
app.use(corsPolicy);
app.use(csrfGuard);
app.use(authGuard);
app.use("/api/std", createStandardizeApi(db));
app.use("/api/title", createTitleApi(db));
app.use("/api", createApi(db));

const dist = path.join(APP_ROOT, "web", "dist");
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get(/^\/(?!api).*/, (_req, res) => res.sendFile(path.join(dist, "index.html")));
}

app.listen(cfg.server.port, cfg.server.bindAddress, () => {
  console.log(`Catalog app listening on ${bindingSummary()}`
    + (fs.existsSync(dist) ? " (serving built frontend)" : " (API only - run vite dev for UI)"));
  console.log(`Database: ${DB_PATH}`);
  console.log(`Configuration: ${fs.existsSync(CONFIG_FILE_PATH) ? CONFIG_FILE_PATH
    : `${CONFIG_FILE_PATH} (not present - built-in defaults in use)`}`);
  if (cfg.server.allowLanAccess) {
    console.warn("WARNING: LAN access is enabled. The application is reachable from "
      + "other machines on your network. Authentication, restricted CORS and CSRF "
      + "protection are active; see SECURITY_GUIDE.md.");
  }
});
