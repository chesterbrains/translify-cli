import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

interface Condition {
  properties?: Record<string, { const?: string; enum?: string[]; not?: { pattern?: string } }>;
  required?: string[];
}
interface Branch {
  not?: { required?: string[] };
}
interface Rule {
  properties: Record<string, { enum?: string[] }>;
  allOf: Array<{ if: Condition; then?: Branch; else?: Branch }>;
}

const schema: { properties: { files: { items: Rule } } } = JSON.parse(
  readFileSync(new URL('../schema/translify.schema.json', import.meta.url), 'utf8'),
);
const rule: Rule = schema.properties.files.items;

/** The subset of `if` the schema uses: `required`, and `const` / `enum` / `not.pattern` on present properties. */
const matches = (condition: Condition, value: Record<string, string>): boolean =>
  (condition.required ?? []).every((name) => name in value) &&
  Object.entries(condition.properties ?? {}).every(([name, check]) => {
    const actual: string | undefined = value[name];
    if (actual === undefined) return true;
    if (check.const !== undefined && actual !== check.const) return false;
    if (check.enum !== undefined && !check.enum.includes(actual)) return false;
    if (check.not?.pattern !== undefined && new RegExp(check.not.pattern).test(actual)) return false;

    return true;
  });

const allowsJsonStyle = (value: Record<string, string>): boolean =>
  rule.allOf.every((entry) => {
    const branch: Branch | undefined = matches(entry.if, value) ? entry.then : entry.else;

    return !(branch?.not?.required ?? []).includes('jsonStyle');
  });

describe('translify.schema.json', () => {
  it('lists the yaml dialects and json styles', () => {
    expect(rule.properties.yamlDialect!.enum).toEqual(['rails', 'symfony', 'symfony-icu']);
    expect([...rule.properties.jsonStyle!.enum!].sort()).toEqual(['flat', 'nested']);
  });

  it('allows jsonStyle on json and the Symfony yaml dialects, not on Rails or other formats', () => {
    const base = { pattern: 'translations/{namespace}.{locale}.yaml', jsonStyle: 'flat' };

    expect(allowsJsonStyle({ ...base, format: 'json' })).toBe(true);
    expect(allowsJsonStyle({ ...base, format: 'yaml', yamlDialect: 'symfony' })).toBe(true);
    expect(allowsJsonStyle({ ...base, format: 'yaml', yamlDialect: 'symfony-icu' })).toBe(true);
    expect(allowsJsonStyle({ ...base, format: 'yaml', yamlDialect: 'rails', namespace: 'app' })).toBe(false);
    expect(allowsJsonStyle({ ...base, format: 'xliff', namespace: 'web' })).toBe(false);
  });
});
