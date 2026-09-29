import { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { hashPassword } from '../auth/password.js';

/**
 * Generate ADMIN_PASSWORD_HASH.
 *   pnpm --filter backend auth:hash-password            (prompts; input is not echoed when on a TTY)
 *   printf '%s' "$PASSWORD" | pnpm --filter backend auth:hash-password
 */
async function readPassword(): Promise<string> {
  if (!stdin.isTTY) {
    let data = '';
    for await (const chunk of stdin) data += chunk;
    return data.replace(/\r?\n$/, '');
  }
  const rl = createInterface({ input: stdin, output: stdout, terminal: true });
  const out = rl as unknown as { _writeToOutput: (s: string) => void };
  stdout.write('Admin password (min 12 characters): ');
  out._writeToOutput = () => {};
  const password = await rl.question('');
  rl.close();
  stdout.write('\n');
  return password;
}

const password = await readPassword();
try {
  console.log(await hashPassword(password));
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
