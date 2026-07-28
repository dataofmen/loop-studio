import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Exclusive claim on a data directory.
 *
 * PGlite loads the database into memory and flushes it back, so two processes
 * pointed at one directory are not two connections — they are two diverging
 * copies, and whichever flushes last wins. That silently destroys data: a
 * survey written by one process simply vanishes when the other saves.
 *
 * Nothing in PGlite prevents it, so the app does. Without this the failure is
 * invisible until data goes missing; with it, the second process refuses to
 * start and says why.
 *
 * The lock records a pid. A crashed owner leaves the file behind, so a lock
 * whose pid is gone is treated as stale and taken over — otherwise a hard kill
 * would brick the app until someone deleted a file by hand.
 */

const LOCK_FILE = "db.lock";

function lockPath(dataDir: string): string {
  return join(dataDir, LOCK_FILE);
}

function isAlive(pid: number): boolean {
  try {
    // Signal 0 checks for existence without delivering anything.
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM means the process exists but belongs to someone else.
    return (e as { code?: string }).code === "EPERM";
  }
}

/** Reads the current holder's pid, or null when unlocked/stale/unreadable. */
export function lockHolder(dataDir: string): number | null {
  try {
    const pid = Number(JSON.parse(readFileSync(lockPath(dataDir), "utf8")).pid);
    return Number.isInteger(pid) && isAlive(pid) ? pid : null;
  } catch {
    return null;
  }
}

/**
 * Claims `dataDir` for this process. Throws if another live process holds it.
 * Returns a release function; also released automatically on exit.
 */
export function acquireDataDirLock(dataDir: string, label: string): () => void {
  const holder = lockHolder(dataDir);
  if (holder !== null && holder !== process.pid) {
    throw new Error(
      `데이터 폴더가 다른 프로세스(pid ${holder})에서 사용 중입니다: ${dataDir}\n` +
        "같은 폴더를 두 프로세스가 열면 데이터가 유실됩니다. 실행 중인 Loop Studio를 먼저 종료하세요.",
    );
  }

  writeFileSync(
    lockPath(dataDir),
    JSON.stringify({ pid: process.pid, label, at: new Date().toISOString() }),
  );

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    // Only drop the file if it is still ours — a takeover must not be undone.
    if (lockHolder(dataDir) === process.pid || lockHolder(dataDir) === null) {
      rmSync(lockPath(dataDir), { force: true });
    }
  };

  process.once("exit", release);
  return release;
}
