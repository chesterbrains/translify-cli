#!/usr/bin/env node
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { checkbox, confirm, input, password } from '@inquirer/prompts';
import { Command, Option } from 'commander';

import { runGet, type GetOptions } from './commands/get.js';
import { runInit, type WhoamiInfo } from './commands/init.js';
import { LINT_SEVERITIES, parseMaxWarnings, runLint, type LintOptions } from './commands/lint.js';
import { runLogin } from './commands/login.js';
import { runPublish } from './commands/publish.js';
import { runPull, type PullOptions } from './commands/pull.js';
import { PUSH_STATUSES, runPush, type PushOptions } from './commands/push.js';
import { runSet, type SetOptions } from './commands/set.js';
import { runWatch } from './commands/watch.js';
import { loadConfig, type Config } from './config.js';
import { askConfirm } from './confirm.js';
import { findKey, resolveKey, saveKey } from './credentials.js';
import { CliError, EXIT } from './errors.js';
import { Api } from './http.js';
import { VERSION } from './version.js';

const out = (line: string): void => {
  process.stdout.write(`${line}\n`);
};
const err = (line: string): void => {
  process.stderr.write(`${line}\n`);
};

const withApi = async (): Promise<{ cwd: string; config: Config; api: Api }> => {
  const cwd: string = process.cwd();
  const config: Config = await loadConfig(cwd);

  return { cwd, config, api: new Api(config.apiUrl, await resolveKey()) };
};

const isTty: boolean = Boolean(process.stdin.isTTY && process.stderr.isTTY);
const DEFAULT_API_URL: string = 'https://translify.tommasofeltrin.work/api';

// Prompts render on stderr so stdout stays clean; Ctrl+C is an ordinary exit, not a bug.
const guarded = async <T>(run: () => Promise<T>, fallback: T): Promise<T> => {
  try {
    return await run();
  } catch (error) {
    if (error instanceof Error && error.name === 'ExitPromptError') return fallback;
    throw error;
  }
};

const program: Command = new Command('translify')
  .version(VERSION)
  .description('Sync translation files with Translify')
  .option('--debug', 'print error details and stack traces');

program
  .command('init')
  .description('Create translify.json for this repository')
  .option('-y, --yes', 'no prompts: take the detected defaults; the key comes from TRANSLIFY_SECRET_KEY or a previous login; never overwrites')
  .option('--api-url <url>', `Translify API URL (default: ${DEFAULT_API_URL})`)
  .action(async (opts: { yes?: boolean; apiUrl?: string }) => {
    process.exitCode = await runInit({
      cwd: process.cwd(),
      isTty,
      yes: opts.yes === true,
      apiUrl: opts.apiUrl,
      apiUrlDefault: DEFAULT_API_URL,
      out,
      prompt: {
        input: async (message, defaultValue) =>
          guarded(async () => input({ message, default: defaultValue }, { output: process.stderr }), ''),
        confirm: async (message, defaultValue) =>
          guarded(async () => confirm({ message, default: defaultValue }, { output: process.stderr }), false),
        checkbox: async (message, options) =>
          guarded(
            async () => checkbox({ message, choices: options.map((value) => ({ value, checked: true })) }, { output: process.stderr }),
            options,
          ),
        // Ctrl+C here is "skip": init goes on without project info.
        secret: async (message) => guarded(async () => password({ message, mask: '*' }, { output: process.stderr }), ''),
      },
      findKey: async () => findKey(),
      saveKey: async (key) => saveKey(key),
      fetchWhoami: async (apiUrl, key) => new Api(apiUrl, key).get<WhoamiInfo>('/cli/v1/whoami'),
    });
  });

program
  .command('login')
  .description('Store a secret key for this machine')
  .action(async () => {
    let apiUrl: string = DEFAULT_API_URL;
    try {
      apiUrl = (await loadConfig(process.cwd())).apiUrl;
    } catch {
      // No (valid) config: log in against the default API.
    }
    process.exitCode = await runLogin({
      isTty,
      apiUrl,
      out,
      promptSecret: async () =>
        guarded(async () => password({ message: 'Secret key (sk_…)', mask: '*' }, { output: process.stderr }), ''),
    });
  });

program
  .command('push')
  .description('Upload source and target files')
  .option('--dry-run', 'show what would change, write nothing')
  .option('--overwrite-targets', 'overwrite existing target-locale translations')
  .option('--prune', 'move keys missing from your source files to the Translify trash (restorable for 30 days); archives exactly the keys you confirmed, and refuses if anything changed meanwhile (re-run to review)')
  .option('-y, --yes', 'confirm destructive flags without prompting')
  .option('--namespace <ns>', 'only this namespace')
  .addOption(
    new Option('--status <status>', 'status target-locale cells land in (default: needs-review when the project requires review, approved otherwise)').choices(PUSH_STATUSES),
  )
  .option('--watch', 'keep running: push source-locale files when they change (Ctrl-C to stop)')
  .option('--debounce <ms>', 'with --watch: quiet time after the last change before pushing (default 2000, minimum 500)')
  .option('--json', 'machine-readable output')
  .action(async (opts: PushOptions) => {
    if (opts.watch === true || opts.debounce !== undefined) {
      const base = await withApi();
      process.exitCode = await runWatch(opts, {
        ...base,
        out,
        err,
        clock: () => new Date(),
        now: () => Date.now(),
        stat: async (path: string) => {
          try {
            const { mtimeMs, size } = await stat(join(base.cwd, path));

            return { mtimeMs, size };
          } catch {
            return undefined;
          }
        },
        read: async (path: string) => new Uint8Array(await readFile(join(base.cwd, path))),
        sleep: (ms: number) => {
          let wake: () => void = () => undefined;
          const done: Promise<void> = new Promise((resolve) => {
            const timer: NodeJS.Timeout = setTimeout(resolve, ms);
            wake = (): void => {
              clearTimeout(timer);
              resolve();
            };
          });

          return { done, wake };
        },
        onSignal: (handler: () => void) => {
          process.on('SIGINT', handler);
          process.on('SIGTERM', handler);

          return (): void => {
            process.off('SIGINT', handler);
            process.off('SIGTERM', handler);
          };
        },
        exit: (code: number) => process.exit(code),
      });

      return;
    }
    process.exitCode = await runPush(opts, {
      ...(await withApi()),
      isTty: Boolean(process.stdin.isTTY && process.stderr.isTTY),
      confirm: askConfirm,
      out,
      err,
    });
  });

program
  .command('publish <environment>')
  .description('Publish an environment')
  .option('--fail-on-withheld', 'exit 5 when the review gate withheld any translation (the publish still happens)')
  .option('--allow-errors', 'publish even when translations with placeholder errors would go live (otherwise refused, exit 6)')
  .option('--json', 'machine-readable output')
  .action(async (environment: string, opts: { json?: boolean; failOnWithheld?: boolean; allowErrors?: boolean }) => {
    const { api, config } = await withApi();
    process.exitCode = await runPublish(environment, {
      api,
      config,
      out,
      json: opts.json,
      failOnWithheld: opts.failOnWithheld,
      allowErrors: opts.allowErrors,
    });
  });

program
  .command('pull')
  .description('Download translation files')
  .option('--from <source>', 'working (default) or env:<slug>')
  .option('--locale <locale>', 'only this locale (as named on disk)')
  .option('--namespace <ns>', 'only this namespace')
  .option('--only-approved', 'approved text only; translations never approved are left out (working copy only)')
  .option('--json', 'machine-readable output')
  .action(async (opts: PullOptions) => {
    process.exitCode = await runPull(opts, { ...(await withApi()), out });
  });

program
  .command('status')
  .description('Exit 1 if local files differ from Translify (CI check)')
  .option('--from <source>', 'working (default) or env:<slug>')
  .option('--locale <locale>', 'only this locale (as named on disk)')
  .option('--namespace <ns>', 'only this namespace')
  .option('--only-approved', 'approved text only; translations never approved are left out (working copy only)')
  .option('--json', 'machine-readable output')
  .action(async (opts: PullOptions) => {
    process.exitCode = await runPull({ ...opts, check: true }, { ...(await withApi()), out });
  });

program
  .command('lint')
  .description('Exit 6 if translations in Translify have placeholder errors (or too many warnings)')
  .option('--namespace <ns>', 'only this namespace')
  .option('--locale <locale>', 'only this locale (as named on disk)')
  .addOption(
    new Option('--severity <severity>', 'only list cells whose worst issue is this severity; counts and the exit code are unaffected').choices(LINT_SEVERITIES),
  )
  .option('--max-warnings <n>', 'also exit 6 when there are more than n warnings')
  .option('--json', 'machine-readable output')
  .action(async (opts: LintOptions) => {
    parseMaxWarnings(opts.maxWarnings);
    process.exitCode = await runLint(opts, { ...(await withApi()), out });
  });

program
  .command('get <key> [locale]')
  .description('Read one key from Translify: every locale, or one raw value')
  .option('--namespace <ns>', 'the key\'s namespace (default: the one translify.json names)')
  .option('--json', 'machine-readable output')
  .action(async (key: string, locale: string | undefined, opts: GetOptions) => {
    process.exitCode = await runGet(key, locale, opts, { ...(await withApi()), out, err });
  });

program
  .command('set <key> <locale> <value>')
  .description('Write one translation to Translify and patch the local JSON file')
  .option('--namespace <ns>', "the key's namespace (default: the one translify.json names)")
  .addOption(new Option('--status <status>', 'status the translation lands in').choices(PUSH_STATUSES))
  .option('--no-write', 'update Translify only, leave local files alone')
  .option('--json', 'machine-readable output')
  .action(async (key: string, locale: string, value: string, opts: SetOptions) => {
    const readStdin = process.stdin.isTTY
      ? undefined
      : async (): Promise<string> => {
          const chunks: Buffer[] = [];
          for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));

          return Buffer.concat(chunks).toString('utf8');
        };
    process.exitCode = await runSet(key, locale, value, opts, { ...(await withApi()), out, err, readStdin });
  });

try {
  await program.parseAsync(process.argv);
} catch (error) {
  // Read from argv too: a failure can come before commander has parsed the global flags.
  const debug: boolean = program.opts<{ debug?: boolean }>().debug === true || process.argv.includes('--debug');
  if (error instanceof CliError) {
    err(error.message);
    // `details` is the parsed response body only; Api never puts the key or request headers in it.
    if (debug && error.details !== undefined) err(JSON.stringify(error.details, null, 2));
    process.exitCode = error.exitCode;
  } else {
    err(`Unexpected error (this is a bug in translify-cli): ${error instanceof Error ? error.message : String(error)}`);
    if (debug && error instanceof Error && error.stack !== undefined) err(error.stack);
    else err('Re-run with --debug for details.');
    process.exitCode = EXIT.network;
  }
}
