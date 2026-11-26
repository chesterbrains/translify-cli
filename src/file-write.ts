import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { access, chmod, lstat, open, readdir, readlink, realpath, rename, rm, stat, writeFile, type FileHandle } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const code = (error: unknown): string | undefined => (error as NodeJS.ErrnoException).code;
const missing = (error: unknown): boolean => code(error) === 'ENOENT';

/**
 * The absolute form of `path` when it lies inside `root`, else undefined. Compared by path segment, so a file or
 * folder whose name merely begins with two dots (`..drafts/en.json`) is inside.
 */
export function insideFolder(root: string, path: string): string | undefined {
  const absolute: string = resolve(root, path);
  const rel: string = relative(resolve(root), absolute);

  return rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel) ? undefined : absolute;
}

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
  /** Flush the temp file to disk before the rename, so a power cut cannot leave an empty file. One fsync per write, so not for bulk writers. */
  sync?: boolean;
  /** Test seam for the rename. */
  move?: typeof rename;
}

async function writeTemp(temp: string, content: string | Uint8Array, sync: boolean): Promise<void> {
  if (!sync) return writeFile(temp, content, { flag: 'wx' });
  const handle: FileHandle = await open(temp, 'wx');
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Write through a temp file beside the target, then rename over it: a crash mid-write leaves the old file whole,
 * and a reader never sees half a file. The target's permission bits are kept and a read-only file is refused as
 * a plain write would refuse it. Where the folder or the mount cannot take the temp file or the rename, the file
 * is written in place instead, as before; so is a file with more than one hard link, which a rename would split
 * from its other names. Owner, ACLs and extended attributes of a replaced file are not carried over. The folder must exist.
 */
export async function writeFileAtomic(path: string, content: string | Uint8Array, options: AtomicWriteOptions = {}): Promise<void> {
  const target: string = await realTarget(path);
  let mode: number | undefined;
  let links = 1;
  try {
    const info = await stat(target);
    mode = info.mode & 0o777;
    links = info.nlink;
    await access(target, constants.W_OK);
  } catch (error) {
    if (!missing(error)) throw error;
  }
  if (links > 1) return writeFile(target, content);

  const temp: string = join(dirname(target), `.${basename(target)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  try {
    await writeTemp(temp, content, options.sync === true);
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
