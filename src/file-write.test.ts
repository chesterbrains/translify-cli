import { chmod, link, lstat, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { insideFolder, renameOver, writeFileAtomic } from './file-write.js';

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

  it('a rename that fails leaves the old file whole and no temp file', async () => {
    const file = join(dir, 'en.json');
    await writeFile(file, 'old');
    const move = vi.fn(async () => {
      throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' });
    });
    await expect(writeFileAtomic(file, 'new', { move: move as never })).rejects.toMatchObject({ code: 'ENOSPC' });
    expect(move).toHaveBeenCalledTimes(1);
    expect(await readFile(file, 'utf8')).toBe('old');
    expect(await readdir(dir)).toEqual(['en.json']);
  });

  it('a mount that cannot rename over the file (a single-file bind mount) is written in place', async () => {
    const file = join(dir, 'en.json');
    await writeFile(file, 'old');
    const move = vi.fn(async () => {
      throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
    });
    await writeFileAtomic(file, 'new', { move: move as never });
    expect(await readFile(file, 'utf8')).toBe('new');
    expect(await readdir(dir)).toEqual(['en.json']);
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('a read-only file is refused, as a plain write would; a missing folder is ENOENT', async () => {
    const file = join(dir, 'en.json');
    await writeFile(file, 'old');
    await chmod(file, 0o444);
    await expect(writeFileAtomic(file, 'new')).rejects.toMatchObject({ code: 'EACCES' });
    expect(await readFile(file, 'utf8')).toBe('old');
    await expect(writeFileAtomic(join(dir, 'missing-folder', 'en.json'), 'x')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readdir(dir)).toEqual(['en.json']);
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('a writable file in a folder that takes no new files is written in place', async () => {
    const folder = join(dir, 'locked');
    await mkdir(folder);
    const file = join(folder, 'en.json');
    await writeFile(file, 'old');
    await chmod(folder, 0o555);
    try {
      await writeFileAtomic(file, 'new');
      expect(await readFile(file, 'utf8')).toBe('new');
    } finally {
      await chmod(folder, 0o755);
    }
  });

  it.skipIf(process.platform === 'win32')('a symlink to a file that does not exist yet is written through, not replaced', async () => {
    const real = join(dir, 'later.json');
    const link = join(dir, 'link.json');
    await symlink('later.json', link);
    await writeFileAtomic(link, 'new');
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect(await readFile(real, 'utf8')).toBe('new');
  });

  it('removes old temp files of the same target left by a crashed run, and only those', async () => {
    const file = join(dir, 'en.json');
    const old = new Date(Date.now() - 2 * 60 * 60_000);
    for (const name of ['.en.json.111.aaaaaaaa.tmp', '.de.json.111.aaaaaaaa.tmp', '.en.json.backup.tmp', '.en.json.b.json.111.aaaaaaaa.tmp', 'en.json.bak']) {
      await writeFile(join(dir, name), 'x');
      await utimes(join(dir, name), old, old);
    }
    await writeFile(join(dir, '.en.json.222.bbbbbbbb.tmp'), 'another run, still writing');
    await writeFileAtomic(file, 'first');
    expect(await readdir(dir)).toContain('.en.json.111.aaaaaaaa.tmp');
    await writeFileAtomic(file, 'new', { sweep: true });
    expect((await readdir(dir)).sort()).toEqual(
      ['.de.json.111.aaaaaaaa.tmp', '.en.json.222.bbbbbbbb.tmp', '.en.json.b.json.111.aaaaaaaa.tmp', '.en.json.backup.tmp', 'en.json', 'en.json.bak'].sort(),
    );
  });
});

describe('renameOver', () => {
  const failing = (code: string, times: number) => {
    let calls = 0;
    const move = vi.fn(async () => {
      if (calls++ < times) throw Object.assign(new Error(code), { code });
    });

    return move as unknown as typeof import('node:fs/promises').rename & typeof move;
  };

  it('on Windows retries a rename refused because the file is held open', async () => {
    const move = failing('EPERM', 2);
    await renameOver('a', 'b', 'win32', move);
    expect(move).toHaveBeenCalledTimes(3);
  });

  it('on Windows gives up after the last delay; elsewhere it never retries; other codes never retry', async () => {
    const stuck = failing('EBUSY', 99);
    await expect(renameOver('a', 'b', 'win32', stuck)).rejects.toMatchObject({ code: 'EBUSY' });
    expect(stuck).toHaveBeenCalledTimes(6);
    const posix = failing('EPERM', 1);
    await expect(renameOver('a', 'b', 'linux', posix)).rejects.toMatchObject({ code: 'EPERM' });
    expect(posix).toHaveBeenCalledTimes(1);
    const other = failing('ENOSPC', 1);
    await expect(renameOver('a', 'b', 'win32', other)).rejects.toMatchObject({ code: 'ENOSPC' });
    expect(other).toHaveBeenCalledTimes(1);
  });
});

describe('writeFileAtomic options', () => {
  it('sync writes the same bytes and leaves no temp file', async () => {
    const file = join(dir, 'en.json');
    await writeFileAtomic(file, 'one', { sync: true });
    await writeFileAtomic(file, 'two', { sync: true });
    expect(await readFile(file, 'utf8')).toBe('two');
    expect(await readdir(dir)).toEqual(['en.json']);
  });

  it.skipIf(process.platform === 'win32')('a file with a second hard link is written in place, so both names keep one content', async () => {
    const file = join(dir, 'en.json');
    const twin = join(dir, 'twin.json');
    await writeFile(file, 'old');
    await link(file, twin);
    await writeFileAtomic(file, 'new');
    expect(await readFile(twin, 'utf8')).toBe('new');
    expect((await stat(file)).nlink).toBe(2);
  });
});

describe('insideFolder', () => {
  it('judges by path segment, not by the first characters', () => {
    const root = join(dir, 'project');
    expect(insideFolder(root, 'locales/en.json')).toBe(join(root, 'locales', 'en.json'));
    expect(insideFolder(root, '..drafts/en.json')).toBe(join(root, '..drafts', 'en.json'));
    expect(insideFolder(root, '..en.json')).toBe(join(root, '..en.json'));
    expect(insideFolder(root, '../en.json')).toBeUndefined();
    expect(insideFolder(root, '..')).toBeUndefined();
    expect(insideFolder(root, 'a/../../en.json')).toBeUndefined();
    expect(insideFolder(root, '.')).toBeUndefined();
    expect(insideFolder(root, join(dir, 'elsewhere', 'en.json'))).toBeUndefined();
  });
});
