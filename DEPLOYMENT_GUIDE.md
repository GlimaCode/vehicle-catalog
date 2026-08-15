# Deployment guide

The application is local-first: `npm start` serves the API and the built frontend on
`http://localhost:4310` with a file-based SQLite database. No paid external API or AI
service is required for any feature.

## Local production run

```bash
npm install
npm run db:init
npm run catalog:import
npm run build
npm start          # http://localhost:4310
```

Environment variables:

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `4310` | HTTP port |
| `CATALOG_DB` | `data/catalog.db` | SQLite database path |
| `CATALOG_DIR` | parent directory | where the catalog CSV files live |

## Deploying to a server later

1. Copy the `catalog-app` directory (or clone the repo) to the server; run the same four
   commands. Node.js ≥ 20 required (better-sqlite3 ships prebuilt binaries for common
   platforms).
2. Put the catalog CSVs next to the app or point `CATALOG_DIR` at them.
3. Run behind a reverse proxy (nginx/Caddy/IIS) for TLS. The app itself has no
   authentication — the Admin routes mutate data, so if you expose it beyond a trusted
   network, restrict `/api/admin/*` and `PATCH /api/reviews/*` at the proxy (e.g. basic
   auth or IP allowlist) until an auth layer is added.
4. Use a process manager (`pm2`, `NSSM`, or a systemd unit) around `npm start`.
5. Schedule `npm run db:backup` (writes timestamped copies to `backups/`); back up the
   `exports/` directory if you want generated workbooks retained.

## Upgrading

- New catalog files: drop them in and re-import (see IMPORT_GUIDE.md) — no rebuild needed.
- New app code: `npm install && npm run build && restart`. The SQLite schema is created
  with `IF NOT EXISTS` and existing data is preserved; destructive schema changes would
  ship with an explicit migration script.
