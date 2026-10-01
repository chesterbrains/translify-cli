#!/usr/bin/env node
import { confirm, input, password, select } from '@inquirer/prompts';
import { Command } from 'commander';

import { runInit, type WhoamiInfo } from './commands/init.js';
import { runLogin } from './commands/login.js';
import { runPublish } from './commands/publish.js';
import { runPull, type PullOptions } from './commands/pull.js';
import { runPush, type PushOptions } from './commands/push.js';
import { loadConfig, type Config } from './config.js';
import { askConfirm } from './confirm.js';
import { resolveKey } from './credentials.js';
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
  .action(async () => {
    process.exitCode = await runInit({
      cwd: process.cwd(),
      isTty,
      out,
      apiUrlDefault: DEFAULT_API_URL,
      prompt: {
        input: async (message, defaultValue) =>
          guarded(async () => input({ message, default: defaultValue }, { output: process.stderr }), ''),
        confirm: async (message, defaultValue) =>
          guarded(async () => confirm({ message, default: defaultValue }, { output: process.stderr }), false),
        choose: async (message, options) =>
          guarded(
            async () => select({ message, choices: options.map((value) => ({ value })) }, { output: process.stderr }),
            options[0] ?? '',
          ),
      },
      fetchWhoami: async (apiUrl: string): Promise<WhoamiInfo | undefined> => {
        try {
          return await new Api(apiUrl, await resolveKey()).get<WhoamiInfo>('/cli/v1/whoami');
        } catch {
          return undefined;
        }
      },
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
  .option('--prune', 'delete keys missing from your source files; published keys are kept; only orphans from the dry run are deleted')
  .option('-y, --yes', 'confirm destructive flags without prompting')
  .option('--namespace <ns>', 'only this namespace')
  .option('--json', 'machine-readable output')
  .action(async (opts: PushOptions) => {
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
  .option('--json', 'machine-readable output')
  .action(async (environment: string, opts: { json?: boolean }) => {
    process.exitCode = await runPublish(environment, { api: (await withApi()).api, out, json: opts.json });
  });

program
  .command('pull')
  .description('Download translation files')
  .option('--from <source>', 'working (default) or env:<slug>')
  .option('--locale <locale>', 'only this locale (as named on disk)')
  .option('--namespace <ns>', 'only this namespace')
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
  .option('--json', 'machine-readable output')
  .action(async (opts: PullOptions) => {
    process.exitCode = await runPull({ ...opts, check: true }, { ...(await withApi()), out });
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
