import { posix } from 'node:path';
import fg from 'fast-glob';

import type { FileRule } from '../config.js';
import { kebab, NONE, type Detection } from './shared.js';

const IGNORE: string[] = ['**/.build/**', '**/Pods/**', '**/node_modules/**', '**/DerivedData/**', '**/.git/**', '**/*.xcloc/**'];

interface Table {
  dir: string;
  table: string;
  lprojs: Set<string>;
  dict: boolean;
}

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Legacy `.lproj` string tables: one `strings` rule per table, plus `stringsdict` when plurals exist. */
export async function detectAppleStrings(cwd: string): Promise<Detection> {
  const files: string[] = await fg(['**/*.lproj/*.strings', '**/*.lproj/*.stringsdict'], {
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
    const group: Table = groups.get(id) ?? { dir, table, lprojs: new Set(), dict: false };
    group.lprojs.add(posix.basename(lproj));
    if (ext === '.stringsdict') group.dict = true;
    groups.set(id, group);
  }

  const notes: string[] = [];
  const counts: Map<string, number> = new Map();
  const rules: FileRule[] = [];
  const sorted: Table[] = [...groups.values()].sort((a, b) => compare(a.dir, b.dir) || compare(a.table, b.table));
  for (const { dir, table, lprojs, dict } of sorted) {
    const base: string = kebab(table) || 'strings';
    const count: number = (counts.get(base) ?? 0) + 1;
    counts.set(base, count);
    const namespace: string = count === 1 ? base : `${base}-${count}`;
    if (count > 1) {
      notes.push(`Two directories hold a ${table} table: the ${count === 2 ? 'second' : `${count}th`} one (${dir}) is namespace ${namespace}.`);
    }
    if (lprojs.size === 1 && lprojs.has('Base.lproj')) {
      notes.push(`Only Base.lproj holds ${table}: map it with "locales": { "Base": "<your default locale>" }`);
    }
    const prefix: string = dir === '.' ? '' : `${dir}/`;
    rules.push({ pattern: `${prefix}{locale}.lproj/${table}.strings`, format: 'strings', namespace });
    if (dict) rules.push({ pattern: `${prefix}{locale}.lproj/${table}.stringsdict`, format: 'stringsdict', namespace });
  }

  return { rules, notes };
}
