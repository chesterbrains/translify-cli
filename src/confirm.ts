import { confirm } from '@inquirer/prompts';

/** Asks on stderr, so stdout stays clean for `--json`. Defaults to no; Ctrl+C counts as no. */
export const askConfirm = async (message: string): Promise<boolean> => {
  try {
    return await confirm({ message, default: false }, { output: process.stderr });
  } catch (error) {
    if (error instanceof Error && error.name === 'ExitPromptError') return false;
    throw error;
  }
};
