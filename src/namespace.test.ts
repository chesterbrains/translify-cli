import { describe, expect, it } from 'vitest';

import type { Config } from './config.js';
import { configNamespace } from './namespace.js';

const rule = (namespace?: string) => ({
  pattern: namespace === undefined ? 'locales/{locale}/{namespace}.json' : `locales/{locale}/${namespace}.json`,
  format: 'json' as const,
  jsonStyle: 'nested' as const,
  ...(namespace === undefined ? {} : { namespace }),
});
const config = (files: ReturnType<typeof rule>[]): Config => ({ apiUrl: 'http://x', files, locales: {} }) as unknown as Config;

describe('configNamespace', () => {
  it('flag wins; one fixed namespace is used; a wildcard or two namespaces give undefined', () => {
    expect(configNamespace(config([rule('shop'), rule()]), 'admin')).toBe('admin');
    expect(configNamespace(config([rule('shop'), rule('shop')]))).toBe('shop');
    expect(configNamespace(config([rule('shop'), rule()]))).toBeUndefined();
    expect(configNamespace(config([rule('shop'), rule('admin')]))).toBeUndefined();
    expect(configNamespace(config([]))).toBeUndefined();
  });
});
