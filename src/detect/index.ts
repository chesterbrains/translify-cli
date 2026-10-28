import { detectAndroid } from './android.js';
import { detectAppleStrings } from './apple-strings.js';
import { detectAngular } from './angular.js';
import { detectFlutter } from './flutter.js';
import { detectI18next } from './i18next.js';
import { ordinal, type Detection, type Detector } from './shared.js';
import { detectXcode } from './xcode.js';

export type { Detection, Detector } from './shared.js';

const DETECTORS: Detector[] = [detectI18next, detectFlutter, detectAngular, detectXcode, detectAndroid, detectAppleStrings];

/**
 * Each detector picks namespaces alone, so two of them can both pick `localizable`. A later detector's
 * namespace is renamed (`-2`, `-3`…) when an earlier detector already took it; a `strings` + `stringsdict`
 * pair from one detector shares its namespace on purpose and is never touched.
 */
const dedupeNamespaces = (found: Detection[]): Detection => {
  const rules: Detection['rules'] = [];
  const notes: string[] = [];
  const owners: Map<string, string> = new Map();
  for (const detection of found) {
    const renames: Map<string, string> = new Map();
    const own: Map<string, string> = new Map();
    for (const rule of detection.rules) {
      const namespace: string | undefined = rule.namespace;
      if (namespace === undefined) {
        rules.push(rule);
        continue;
      }
      let name: string | undefined = renames.get(namespace);
      if (name === undefined) {
        name = namespace;
        const first: string | undefined = owners.get(namespace);
        if (first !== undefined) {
          let n: number = 2;
          while (owners.has(`${namespace}-${n}`)) n++;
          name = `${namespace}-${n}`;
          notes.push(`${rule.pattern} and ${first} would both be namespace ${namespace}: the ${ordinal(n)} one is namespace ${name}.`);
        }
        renames.set(namespace, name);
      }
      if (!own.has(name)) own.set(name, rule.pattern);
      rules.push(name === namespace ? rule : { ...rule, namespace: name });
    }
    for (const [name, pattern] of own) owners.set(name, pattern);
    notes.push(...detection.notes);
  }

  return { rules, notes };
};

/** Looks only in `cwd`. An empty `rules` list means "unknown, write an example". */
export async function detectLayout(cwd: string): Promise<Detection> {
  const found: Detection[] = [];
  for (const detect of DETECTORS) found.push(await detect(cwd));

  return dedupeNamespaces(found);
}
