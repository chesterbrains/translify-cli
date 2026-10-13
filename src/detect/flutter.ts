import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import fg from 'fast-glob';

import type { FileRule } from '../config.js';
import type { Detection } from './shared.js';

const unquote = (value: string): string =>
  value.replace(/^["']|["']$/g, '').replace(/^(\.\/)+/, '').replace(/\/+$/, '');

export async function detectFlutter(cwd: string): Promise<Detection> {
  let yaml: string | undefined;
  try {
    yaml = await readFile(join(cwd, 'l10n.yaml'), 'utf8');
  } catch {
    yaml = undefined;
  }

  if (yaml === undefined) {
    const arbs: string[] = await fg('lib/l10n/*.arb', { cwd, onlyFiles: true });
    const rules: FileRule[] = arbs.length > 0 ? [{ pattern: 'lib/l10n/app_{locale}.arb', format: 'arb', namespace: 'app' }] : [];

    return { rules, notes: [] };
  }

  const dir: string = unquote(/^arb-dir:\s*(\S+)/m.exec(yaml)?.[1] ?? 'lib/l10n');
  const template: string = unquote(/^template-arb-file:\s*(\S+)/m.exec(yaml)?.[1] ?? 'app_en.arb');
  const prefix: string = /^(.*?)_[a-z]{2,3}(?:[_-](?:[A-Z]{2}|[0-9]{3}|[A-Z][a-z]{3}))*\.arb$/.exec(template)?.[1] ?? 'app';

  return { rules: [{ pattern: `${dir}/${prefix}_{locale}.arb`, format: 'arb', namespace: 'app' }], notes: [] };
}
