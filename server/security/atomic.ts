/**
 * Atomic file output.
 *
 * Generated files are written to a temporary name in the same directory and
 * renamed into place only after the write completes, so an interrupted or
 * failed export can never leave a partial file that looks complete. Temporary
 * artifacts are removed on failure and swept on startup.
 */
import fs from "node:fs";
import path from "node:path";
import { newStorageId } from "./filenames.js";

export const TEMP_SUFFIX = ".part";

export function tempPathFor(finalPath: string): string {
  return `${finalPath}.${newStorageId()}${TEMP_SUFFIX}`;
}

function friendlyFsError(e: unknown, target: string): Error {
  const code = (e as NodeJS.ErrnoException)?.code;
  if (code === "ENOSPC") {
    return new Error(`Not enough disk space to write ${path.basename(target)}. `
      + "Free some space and export again; no partial file was kept.");
  }
  if (code === "EACCES" || code === "EPERM") {
    return new Error(`Permission denied writing ${path.basename(target)}. `
      + "Check folder permissions; no partial file was kept.");
  }
  if (code === "EBUSY") {
    return new Error(`${path.basename(target)} is locked by another program `
      + "(is it open in Excel?). Close it and export again.");
  }
  if (code === "ENOENT") {
    return new Error(`The export destination is unavailable: ${path.dirname(target)}`);
  }
  return e instanceof Error ? e : new Error(String(e));
}

/** Write a buffer/string atomically. */
export function writeFileAtomic(finalPath: string, data: string | Buffer): void {
  const tmp = tempPathFor(finalPath);
  try {
    fs.mkdirSync(path.dirname(finalPath), { recursive: true });
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, finalPath);
  } catch (e) {
    try { if (fs.existsSync(tmp)) fs.rmSync(tmp); } catch { /* best effort */ }
    throw friendlyFsError(e, finalPath);
  }
}

/** Run a writer against a temporary path, then rename it into place. */
export async function writeViaTemp(finalPath: string,
  writer: (tempPath: string) => Promise<void> | void): Promise<string> {
  const tmp = tempPathFor(finalPath);
  try {
    fs.mkdirSync(path.dirname(finalPath), { recursive: true });
    await writer(tmp);
    if (!fs.existsSync(tmp) || fs.statSync(tmp).size === 0) {
      throw new Error("writer produced no output");
    }
    fs.renameSync(tmp, finalPath);
    return finalPath;
  } catch (e) {
    try { if (fs.existsSync(tmp)) fs.rmSync(tmp); } catch { /* best effort */ }
    throw friendlyFsError(e, finalPath);
  }
}

/** Remove leftover *.part files (startup sweep / after-export cleanup). */
export function sweepTempFiles(dir: string): string[] {
  const removed: string[] = [];
  if (!fs.existsSync(dir)) return removed;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      removed.push(...sweepTempFiles(full));
    } else if (entry.name.endsWith(TEMP_SUFFIX)) {
      try { fs.rmSync(full); removed.push(full); } catch { /* best effort */ }
    }
  }
  return removed;
}
