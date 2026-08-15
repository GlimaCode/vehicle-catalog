/**
 * Concurrency safety.
 *
 * Project-level locks let independent projects run at the same time, while a
 * small set of operations (backup, restore, canonical catalog import) take a
 * global exclusive lock. Callers receive a clear, user-facing message when an
 * operation cannot safely proceed rather than corrupting state.
 */
export type LockKind = "process" | "export" | "delete" | "global"
  | "title-process" | "title-export";

export class LockBusyError extends Error {
  constructor(message: string, readonly holder: string) {
    super(message);
    this.name = "LockBusyError";
  }
}

interface Held { key: string; kind: LockKind; since: number; label: string }

const held = new Map<string, Held>();
let globalHolder: Held | null = null;

const keyFor = (kind: LockKind, projectId?: number) =>
  kind === "global" ? "global" : `${kind}:${projectId}`;

export function isBusy(kind: LockKind, projectId?: number): boolean {
  if (globalHolder) return true;
  return held.has(keyFor(kind, projectId));
}

export function currentHolders(): { key: string; label: string; seconds: number }[] {
  const all = [...held.values(), ...(globalHolder ? [globalHolder] : [])];
  return all.map((h) => ({ key: h.key, label: h.label,
    seconds: Math.round((Date.now() - h.since) / 1000) }));
}

/** Acquire a lock, run `fn`, and always release (even on throw). */
export async function withLock<T>(kind: LockKind, projectId: number | undefined,
  label: string, fn: () => Promise<T> | T): Promise<T> {
  const key = keyFor(kind, projectId);
  if (globalHolder) {
    throw new LockBusyError(
      `Cannot start "${label}" while "${globalHolder.label}" is running. `
      + "That operation needs exclusive access; please wait for it to finish.",
      globalHolder.label);
  }
  if (kind === "global") {
    const others = [...held.values()];
    if (others.length) {
      throw new LockBusyError(
        `Cannot start "${label}" while ${others.length} job(s) are active `
        + `(${others.map((o) => o.label).join(", ")}). Wait for them to finish or `
        + "cancel them first.", others[0].label);
    }
  }
  if (held.has(key)) {
    const h = held.get(key)!;
    throw new LockBusyError(
      `"${label}" is already running for this project (started ${
        Math.round((Date.now() - h.since) / 1000)}s ago). `
      + "Wait for it to finish rather than starting it twice.", h.label);
  }
  const entry: Held = { key, kind, since: Date.now(), label };
  if (kind === "global") globalHolder = entry; else held.set(key, entry);
  try {
    return await fn();
  } finally {
    if (kind === "global") globalHolder = null; else held.delete(key);
  }
}

/** Release everything (used by tests and by startup recovery). */
export function resetLocks(): void {
  held.clear();
  globalHolder = null;
}
