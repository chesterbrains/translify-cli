import { randomBytes } from 'node:crypto';
import { chmod, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
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

/**
 * Write through a temp file beside the target, then rename over it: a crash mid-write leaves the old file whole,
 * and a reader never sees half a file. The target's permission bits are kept. The folder must exist.
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
  const temp: string = join(dirname(target), `.${basename(target)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  try {
    await writeFile(temp, content, { flag: 'wx' });
    // Explicitly, because the mode given at creation is cut down by the umask.
    if (mode !== undefined) await chmod(temp, mode);
    await rename(temp, target);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}
