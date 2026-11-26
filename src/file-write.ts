import { randomBytes } from 'node:crypto';
import { chmod, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === 'ENOENT';

/** The file a path really names: a symlink is followed, so the link itself is never replaced. A missing file is its own path. */
export async function realTarget(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if (!missing(error)) throw error;

    return path;
  }
}

const TEMP_SUFFIX = '.tmp';
/** A temp file older than this was left by a process that died between the write and the rename. */
const TEMP_MAX_AGE_MS = 60_000;
/** Windows refuses a rename onto a file another program (an editor, a virus scanner) holds open; it usually lets go within moments. */
const RENAME_RETRY_CODES: ReadonlySet<string> = new Set(['EPERM', 'EACCES', 'EBUSY']);
const RENAME_RETRY_DELAYS_MS: readonly number[] = [20, 50, 100, 200, 400];

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

/** `rename`, retried on Windows only: elsewhere these codes are real permission errors and waiting would not help. */
export async function renameOver(from: string, to: string, platform: string = process.platform, move: typeof rename = rename): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await move(from, to);

      return;
    } catch (error) {
      const delay: number | undefined = RENAME_RETRY_DELAYS_MS[attempt];
      const retry: boolean = platform === 'win32' && RENAME_RETRY_CODES.has((error as NodeJS.ErrnoException).code ?? '');
      if (!retry || delay === undefined) throw error;
      await sleep(delay);
    }
  }
}

/** Best effort: remove this target's temp files that a crashed run left in the folder. Never fails the write. */
async function sweepTemps(target: string, now: number): Promise<void> {
  const folder: string = dirname(target);
  const prefix = `.${basename(target)}.`;
  try {
    for (const name of await readdir(folder)) {
      if (!name.startsWith(prefix) || !name.endsWith(TEMP_SUFFIX)) continue;
      const path: string = join(folder, name);
      if (now - (await stat(path)).mtimeMs > TEMP_MAX_AGE_MS) await rm(path, { force: true });
    }
  } catch {
    // A folder that cannot be listed, or a file that vanished meanwhile: nothing to clean.
  }
}

/**
 * Write through a temp file beside the target, then rename over it: a crash mid-write leaves the old file whole,
 * and a reader never sees half a file. The target's permission bits are kept. The folder must exist.
 * Temp files of this target left by a crashed run are removed on the way.
 */
export async function writeFileAtomic(path: string, content: string | Uint8Array): Promise<void> {
  const target: string = await realTarget(path);
  let mode: number | undefined;
  try {
    mode = (await stat(target)).mode & 0o777;
  } catch (error) {
    if (!missing(error)) throw error;
  }

  // Ends in `.tmp`, so no files pattern picks it up if a crash leaves it behind.
  const temp: string = join(dirname(target), `.${basename(target)}.${process.pid}.${randomBytes(4).toString('hex')}${TEMP_SUFFIX}`);
  try {
    await writeFile(temp, content, { flag: 'wx' });
    // Explicitly, because the mode given at creation is cut down by the umask.
    if (mode !== undefined) await chmod(temp, mode);
    await renameOver(temp, target);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
  await sweepTemps(target, Date.now());
}
