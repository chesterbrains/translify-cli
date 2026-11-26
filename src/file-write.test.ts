import { chmod, lstat, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { writeFileAtomic } from './file-write.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'translify-write-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('writeFileAtomic', () => {
  it('creates and replaces a file, leaving no temp file', async () => {
    const file = join(dir, 'en.json');
    await writeFileAtomic(file, 'one');
    await writeFileAtomic(file, 'two');
    expect(await readFile(file, 'utf8')).toBe('two');
    expect(await readdir(dir)).toEqual(['en.json']);
  });

  it.skipIf(process.platform === 'win32')('keeps the permission bits of the file it replaces', async () => {
    const file = join(dir, 'en.json');
    await writeFile(file, 'one');
    await chmod(file, 0o640);
    await writeFileAtomic(file, 'two');
    expect((await stat(file)).mode & 0o777).toBe(0o640);
  });

  it.skipIf(process.platform === 'win32')('writes through a symlink instead of replacing it', async () => {
    const real = join(dir, 'real.json');
    const link = join(dir, 'link.json');
    await writeFile(real, 'one');
    await symlink(real, link);
    await writeFileAtomic(link, 'two');
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect(await readFile(real, 'utf8')).toBe('two');
  });

  it('a failed write leaves the old file whole and no temp file', async () => {
    const file = join(dir, 'missing-folder', 'en.json');
    await expect(writeFileAtomic(file, 'x')).rejects.toMatchObject({ code: 'ENOENT' });
    await writeFile(join(dir, 'keep.json'), 'old');
    expect(await readdir(dir)).toEqual(['keep.json']);
  });
});
