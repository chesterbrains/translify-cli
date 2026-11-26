import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { access, chmod, lstat, readdir, readlink, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

const code = (error: unknown): string | undefined => (error as NodeJS.ErrnoException).code;
const missing = (error: unknown): boolean => code(error) === 'ENOENT';

/**
 * The file a path really names: a symlink is followed, so the link itself is never replaced, also when what it
 * points at does not exist yet. A missing file is its own path.
 */
export async function realTarget(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if (!missing(error)) throw error;
  }
  try {
    if ((await lstat(path)).isSymbolicLink()) return resolve(dirname(path), await readlink(path));
  } catch (error) {
    if (!missing(error)) throw error;
  }

  return path;
}

/** A temp file older than this was left by a process that died between the write and the rename. */
const TEMP_MAX_AGE_MS = 60 * 60_000;
const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const tempPattern = (name: string): RegExp => new RegExp(`^\\.${escapeRegExp(name)}\\.\\d+\\.[0-9a-f]{8}\\.tmp$`);

/** Windows refuses a rename onto a file another program (an editor, a virus scanner) holds open; it usually lets go within moments. */
const RENAME_RETRY_CODES: ReadonlySet<string> = new Set(['EPERM', 'EACCES', 'EBUSY']);
const RENAME_RETRY_DELAYS_MS: readonly number[] = [20, 50, 100, 200, 400];
/**
 * Where a temp file plus rename cannot work but writing the file itself may: a file mounted on its own into a
 * container (EBUSY, EXDEV on the rename), or a writable file in a folder that takes no new files.
 */
const IN_PLACE_CODES: ReadonlySet<string> = new Set(['EBUSY', 'EXDEV', 'EACCES', 'EPERM', 'EROFS']);

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

/** `rename`, retried on Windows only: elsewhere these codes are real refusals and waiting would not help. */
export async function renameOver(from: string, to: string, platform: string = process.platform, move: typeof rename = rename): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await move(from, to);

      return;
    } catch (error) {
      const delay: number | undefined = RENAME_RETRY_DELAYS_MS[attempt];
      const retry: boolean = platform === 'win32' && RENAME_RETRY_CODES.has(code(error) ?? '');
      if (!retry || delay === undefined) throw error;
      await sleep(delay);
    }
  }
}

/** Best effort: remove this target's own temp files that a crashed run left in the folder. Never fails the write. */
async function sweepTemps(target: string, now: number): Promise<void> {
  const folder: string = dirname(target);
  const pattern: RegExp = tempPattern(basename(target));
  try {
    for (const name of await readdir(folder)) {
      if (!pattern.test(name)) continue;
      const path: string = join(folder, name);
      if (now - (await stat(path)).mtimeMs > TEMP_MAX_AGE_MS) await rm(path, { force: true });
    }
  } catch {
    // A folder that cannot be listed, or a file that vanished meanwhile: nothing to clean.
  }
}

export interface AtomicWriteOptions {
  /** Also remove this target's temp files left by a crashed run. One folder listing per write, so not for bulk writers. */
  sweep?: boolean;
  /** Test seam for the rename. */
  move?: typeof rename;
}

/**
 * Write through a temp file beside the target, then rename over it: a crash mid-write leaves the old file whole,
 * and a reader never sees half a file. The target's permission bits are kept and a read-only file is refused as
 * a plain write would refuse it. Where the folder or the mount cannot take the temp file or the rename, the file
 * is written in place instead, as before. The folder must exist. Not synced to disk: a power cut can still lose it.
 */
export async function writeFileAtomic(path: string, content: string | Uint8Array, options: AtomicWriteOptions = {}): Promise<void> {
  const target: string = await realTarget(path);
  let mode: number | undefined;
  try {
    mode = (await stat(target)).mode & 0o777;
    await access(target, constants.W_OK);
  } catch (error) {
    if (!missing(error)) throw error;
  }

  const temp: string = join(dirname(target), `.${basename(target)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  try {
    await writeFile(temp, content, { flag: 'wx' });
    // Explicitly, because the mode given at creation is cut down by the umask. Some mounts refuse chmod; the write still counts.
    if (mode !== undefined) await chmod(temp, mode).catch(() => undefined);
    await renameOver(temp, target, process.platform, options.move);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    if (!IN_PLACE_CODES.has(code(error) ?? '')) throw error;
    await writeFile(target, content);
  }
  if (options.sweep === true) await sweepTemps(target, Date.now());
}
