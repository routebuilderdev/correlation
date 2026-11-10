/**
 * Runs on disk.
 *
 * The UI polls a map in memory, which is right for a live run and wrong for
 * everything after it: stop the server and twenty signed receipts are gone, so
 * there is nothing to replay when the model is unreachable on demo day (§13
 * fallback). Every finished run is written once to `.runs/`, and a request for
 * a run the process has never seen is served from there.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNS_DIR = join(HERE, "..", ".runs");

export async function saveRun(id: string, run: unknown): Promise<void> {
  await mkdir(RUNS_DIR, { recursive: true });
  await writeFile(join(RUNS_DIR, `${id}.json`), JSON.stringify(run, null, 2), "utf8");
}

export async function loadRun<T>(id: string): Promise<T | null> {
  // The id reaches a filesystem path, so anything but our own format is refused
  // before it is joined: `../..` is a read of an arbitrary file.
  if (!/^run-[a-z0-9-]{1,64}$/.test(id)) return null;
  try {
    return JSON.parse(await readFile(join(RUNS_DIR, `${id}.json`), "utf8")) as T;
  } catch {
    return null;
  }
}
