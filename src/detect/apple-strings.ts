import { posix } from 'node:path';
import fg from 'fast-glob';

import type { FileRule } from '../config.js';
import { IGNORE, kebab, NONE, ordinal, type Detection } from './shared.js';

interface Table {
  dir: string;
  table: string;
  lprojs: Set<string>;
  dict: boolean;
  plain: boolean;
  /** An Interface Builder file (`<Table>.storyboard` / `.xib`) sits next to the table. */
  ib: boolean;
}

/** A development language: the only place a source-language file can live. */
const SOURCE_LPROJ: RegExp = /^(en([-_][^.]*)?|Base)\.lproj$/i;

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Legacy `.lproj` string tables: one `strings` rule per table, plus `stringsdict` when plurals exist. */
export async function detectAppleStrings(cwd: string): Promise<Detection> {
  const files: string[] = await fg(['**/*.lproj/*.strings', '**/*.lproj/*.stringsdict', '**/*.lproj/*.storyboard', '**/*.lproj/*.xib'], {
    cwd,
    onlyFiles: true,
    dot: false,
    ignore: IGNORE,
  });
  if (files.length === 0) return NONE;

  const groups: Map<string, Table> = new Map();
  for (const file of files) {
    const lproj: string = posix.dirname(file);
    const dir: string = posix.dirname(lproj);
    const ext: string = posix.extname(file);
    const table: string = posix.basename(file, ext);
    const id: string = `${dir}\0${table}`;
    const group: Table = groups.get(id) ?? { dir, table, lprojs: new Set(), dict: false, plain: false, ib: false };
    if (ext === '.storyboard' || ext === '.xib') group.ib = true;
    else group.lprojs.add(posix.basename(lproj));
    if (ext === '.stringsdict') group.dict = true;
    if (ext === '.strings') group.plain = true;
    groups.set(id, group);
  }

  const notes: string[] = [];
  const counts: Map<string, number> = new Map();
  const rules: FileRule[] = [];
  const sorted: Table[] = [...groups.values()].sort((a, b) => compare(a.dir, b.dir) || compare(a.table, b.table));
  for (const { dir, table, lprojs, dict, plain, ib } of sorted) {
    if (lprojs.size === 0) continue;
    if (ib) {
      notes.push(`${table}.strings localizes Interface Builder; not managed.`);
      continue;
    }
    if (table === 'InfoPlist' && ![...lprojs].some((name) => SOURCE_LPROJ.test(name))) {
      notes.push(`${table}.strings has no source-language file; not managed.`);
      continue;
    }
    const base: string = kebab(table) || 'strings';
    const count: number = (counts.get(base) ?? 0) + 1;
    counts.set(base, count);
    const namespace: string = count === 1 ? base : `${base}-${count}`;
    if (count > 1) {
      notes.push(`Two directories hold a ${table} table: the ${ordinal(count)} one (${dir}) is namespace ${namespace}.`);
    }
    if (lprojs.has('Base.lproj')) {
      notes.push(`Base.lproj holds ${table}: map it with "locales": { "Base": "<your default locale>" }`);
    }
    const prefix: string = dir === '.' ? '' : `${dir}/`;
    if (plain) rules.push({ pattern: `${prefix}{locale}.lproj/${table}.strings`, format: 'strings', namespace });
    if (dict) rules.push({ pattern: `${prefix}{locale}.lproj/${table}.stringsdict`, format: 'stringsdict', namespace });
  }

  return { rules, notes };
}
