#!/usr/bin/env node
import { Command } from 'commander';

import { VERSION } from './version.js';

const program: Command = new Command('translify').version(VERSION).description('Sync translation files with Translify');

await program.parseAsync(process.argv);
