import { describe, expect, it } from 'vitest';

import { CliError, EXIT } from '../errors.js';
import { watchVerdict } from './verdict.js';

const http = (status: number, code?: string): CliError => new CliError(EXIT.failed, 'm', { code }, status);

describe('watchVerdict', () => {
  it.each([
    ['network or timeout (no status)', new CliError(EXIT.network, 'Could not reach'), 'retry'],
    ['500', http(500), 'retry'],
    ['503', http(503), 'retry'],
    ['429', http(429, 'RATE_LIMITED'), 'retry'],
    ['409 TRANSACTION_CONFLICT', http(409, 'TRANSACTION_CONFLICT'), 'retry'],
    ['409 without a code', http(409), 'retry'],
    ['408 from a proxy', http(408), 'retry'],
    ['401 KEY_INVALID', http(401, 'KEY_INVALID'), 'stop'],
    ['403 SCOPE_MISSING', http(403, 'SCOPE_MISSING'), 'stop'],
    ['426 CLI_TOO_OLD', http(426, 'CLI_TOO_OLD'), 'stop'],
    ['400 PROJECT_ARCHIVED', http(400, 'PROJECT_ARCHIVED'), 'stop'],
    ['422 VALIDATION_FAILED', http(422, 'VALIDATION_FAILED'), 'wait'],
    ['413 PUSH_TOO_LARGE', http(413, 'PUSH_TOO_LARGE'), 'wait'],
    ['402 QUOTA_EXCEEDED', http(402, 'QUOTA_EXCEEDED'), 'wait'],
    ['400 BAD_REQUEST', http(400, 'BAD_REQUEST'), 'wait'],
  ])('%s', (_name, error, verdict) => {
    expect(watchVerdict(error)).toBe(verdict);
  });

  it('rethrows what is not a CliError: that is a bug, not a push outcome', () => {
    expect(() => watchVerdict(new Error('bug'))).toThrow('bug');
  });
});
