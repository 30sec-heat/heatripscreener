/**
 * Run locally ONCE to obtain TELEGRAM_SESSION_STRING for Railway.
 *
 *   TELEGRAM_API_ID=... TELEGRAM_API_HASH=... npm run telegram:login
 *
 * Paste the printed TELEGRAM_SESSION_STRING into Railway Variables (secret).
 * Do not commit the session string or api hash.
 */
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';
import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

const apiId = Number(process.env.TELEGRAM_API_ID);
const apiHash = process.env.TELEGRAM_API_HASH?.trim();
if (!apiId || !apiHash) {
  console.error('Set TELEGRAM_API_ID and TELEGRAM_API_HASH (from https://my.telegram.org)');
  process.exit(1);
}

const rl = readline.createInterface({ input, output });
const session = new StringSession('');
const client = new TelegramClient(session, apiId, apiHash, { connectionRetries: 5 });

await client.start({
  phoneNumber: async () => (await rl.question('Phone (+country code, e.g. +49123...): ')).trim(),
  password: async () => (await rl.question('2FA password (empty if none): ')).trim(),
  phoneCode: async () => (await rl.question('Code from Telegram: ')).trim(),
  onError: (err) => console.error(err),
});

const saved = client.session.save() as string;
console.log('\n--- Add this to Railway (Variable: TELEGRAM_SESSION_STRING) ---\n');
console.log(saved);
console.log('\n--- Also set TELEGRAM_API_ID and TELEGRAM_API_HASH as secrets. ---\n');

await client.disconnect();
rl.close();
