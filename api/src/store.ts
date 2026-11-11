/**
 * Runs on disk.
 *
 * The UI polls a map in memory, which is right for a live run and wrong for
 * everything after it: stop the server and twenty signed receipts are gone, so
 * there is nothing to replay when the model is unreachable on demo day (§13
 * fallback). Every finished run is written once to `.runs/`, and a request for
 * a run the process has never seen is served from there.
 */
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Read per call so the tests can point it at a temporary directory. */
function runsDir(): string {
  return process.env.RUNS_DIR ?? join(HERE, "..", ".runs");
}

export async function saveRun(id: string, run: unknown): Promise<void> {
  const dir = runsDir();
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${id}.json`), JSON.stringify(run, null, 2), "utf8");
}

/**
 * The newest run recorded for a policy.
 *
 * A browser reload only knows about runs it started itself, so a page opened
 * after the fact used to render twenty empty cells beside a chain that says all
 * twenty receipts landed. The run is on disk; this is how the page finds it.
 */
export async function latestRunFor<T>(policyId: number): Promise<T | null> {
  let files: string[];
  try {
    files = await readdir(runsDir());
  } catch {
    return null;
  }
  let best: { startedAt: string; run: T } | null = null;
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    const run = await loadRun<T & { policyId?: number; startedAt?: string }>(
      file.slice(0, -".json".length),
    );
    if (!run || run.policyId !== policyId) continue;
    const startedAt = String(run.startedAt ?? "");
    if (!best || startedAt > best.startedAt) best = { startedAt, run };
  }
  return best?.run ?? null;
}

export async function loadRun<T>(id: string): Promise<T | null> {
  // The id reaches a filesystem path, so anything but our own format is refused
  // before it is joined: `../..` is a read of an arbitrary file.
  if (!/^run-[a-z0-9-]{1,64}$/.test(id)) return null;
  try {
    return JSON.parse(await readFile(join(runsDir(), `${id}.json`), "utf8")) as T;
  } catch {
    return null;
  }
}
