/**
 * Documented, configurable application policy (Version 5.1 hardening).
 *
 * Values are read from `config/app-config.json` when present, otherwise these
 * defaults apply. Every limit exists to keep the local application safe when
 * processing large, potentially untrusted CSV/XLSX files.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG_PATH = process.env.CATALOG_CONFIG
  ?? path.join(APP_ROOT, "config", "app-config.json");

export interface AppConfig {
  server: {
    /** Default bind address. 127.0.0.1 = local only (recommended). */
    bindAddress: string;
    port: number;
    /** Opt-in LAN exposure; requires auth when true. */
    allowLanAccess: boolean;
    /** Required when allowLanAccess is true. */
    authToken: string;
    allowedOrigins: string[];
  };
  upload: {
    maxFileBytes: number;
    allowedExtensions: string[];
    /** Reject macro-enabled workbooks (.xlsm/.xltm and vbaProject.bin). */
    allowMacroEnabledWorkbooks: boolean;
  };
  workbook: {
    maxZipEntries: number;
    maxTotalUncompressedBytes: number;
    maxCompressionRatio: number;
    maxWorksheets: number;
    maxRows: number;
    maxColumns: number;
    maxCells: number;
    maxSharedStringBytes: number;
    maxCellLength: number;
  };
  exportSecurity: {
    /** Neutralize values that spreadsheets would evaluate as formulas. */
    formulaInjectionProtection: boolean;
    /** "prefix-apostrophe" keeps the text visible and inert in Excel. */
    strategy: "prefix-apostrophe";
    /** Fields whose application-generated URLs stay clickable. */
    trustedHyperlinkFields: string[];
  };
  retention: {
    /** Delete the stored upload once a project has imported successfully. */
    deleteUploadAfterImport: boolean;
    deleteTemporaryFilesAfterExport: boolean;
    /** 0 = never auto-purge. */
    autoPurgeProjectsAfterDays: number;
    keepAuditMetadataOnDelete: boolean;
  };
  processing: {
    batchSize: number;
    maxConcurrentProjects: number;
  };
  /** Title Optimizer settings. Title-only; never affects canonical data. */
  title: {
    maxCharacters: number;
    defaultExportMode: "audit" | "replacement";
    preferFullWords: boolean;
  };
}

export const DEFAULT_CONFIG: AppConfig = {
  server: {
    bindAddress: "127.0.0.1",
    port: 4310,
    allowLanAccess: false,
    authToken: "",
    allowedOrigins: [],
  },
  upload: {
    maxFileBytes: 512 * 1024 * 1024,          // 512 MB
    allowedExtensions: [".csv", ".txt", ".xlsx"],
    allowMacroEnabledWorkbooks: false,
  },
  workbook: {
    maxZipEntries: 2000,
    maxTotalUncompressedBytes: 2 * 1024 * 1024 * 1024,   // 2 GB expanded
    maxCompressionRatio: 200,                            // zip-bomb guard
    maxWorksheets: 64,
    maxRows: 1_000_000,
    maxColumns: 1024,
    maxCells: 50_000_000,
    maxSharedStringBytes: 256 * 1024 * 1024,
    maxCellLength: 32_767,                               // Excel's own limit
  },
  exportSecurity: {
    formulaInjectionProtection: true,
    strategy: "prefix-apostrophe",
    trustedHyperlinkFields: ["Primary Source URL", "Secondary Source URL",
      "Source URL", "Source", "Primary Source", "Secondary Source"],
  },
  retention: {
    deleteUploadAfterImport: false,
    deleteTemporaryFilesAfterExport: true,
    autoPurgeProjectsAfterDays: 0,
    keepAuditMetadataOnDelete: true,
  },
  processing: {
    batchSize: 1000,
    maxConcurrentProjects: 4,
  },
  title: {
    maxCharacters: 80,               // Unicode code points, not bytes
    defaultExportMode: "audit",      // audit mode preserves the original Title
    preferFullWords: true,           // abbreviate only when over the limit
  },
};

function deepMerge<T>(base: T, override: unknown): T {
  if (!override || typeof override !== "object") return base;
  const out = { ...base } as Record<string, unknown>;
  for (const [k, v] of Object.entries(override as Record<string, unknown>)) {
    const cur = (base as Record<string, unknown>)[k];
    out[k] = (cur && typeof cur === "object" && !Array.isArray(cur))
      ? deepMerge(cur, v) : v;
  }
  return out as T;
}

let cached: AppConfig | null = null;

export function loadConfig(force = false): AppConfig {
  if (cached && !force) return cached;
  let cfg = DEFAULT_CONFIG;
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      cfg = deepMerge(DEFAULT_CONFIG,
        JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8").replace(/^﻿/, "")));
    } catch (e) {
      console.warn(`[config] ${CONFIG_PATH} is invalid, using defaults: ${String(e)}`);
    }
  }
  // environment overrides (documented in SECURITY_GUIDE.md)
  if (process.env.PORT) cfg.server.port = Number(process.env.PORT);
  if (process.env.CATALOG_BIND) cfg.server.bindAddress = process.env.CATALOG_BIND;
  if (process.env.CATALOG_ALLOW_LAN === "1") cfg.server.allowLanAccess = true;
  if (process.env.CATALOG_AUTH_TOKEN) cfg.server.authToken = process.env.CATALOG_AUTH_TOKEN;
  cached = cfg;
  return cfg;
}

export const CONFIG_FILE_PATH = CONFIG_PATH;
