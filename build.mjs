import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { build } from 'esbuild';

const projectUrl = process.env.SUPABASE_URL?.trim();
const publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY?.trim();

if (Boolean(projectUrl) !== Boolean(publishableKey)) {
  throw new Error('Set both SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY in .env.');
}

let supabaseUrl = '';
if (projectUrl) {
  const url = new URL(projectUrl);
  const local = ['localhost', '127.0.0.1'].includes(url.hostname);
  const allowedProtocol = url.protocol === 'https:' || (local && url.protocol === 'http:');
  if (!allowedProtocol || url.href !== `${url.origin}/`) {
    throw new Error('SUPABASE_URL must be the project origin. HTTP is supported on localhost.');
  }
  if (publishableKey.startsWith('eyJ')) {
    const claims = JSON.parse(Buffer.from(publishableKey.split('.')[1], 'base64url'));
    if (claims.role !== 'anon') throw new Error('Use a Supabase publishable or anon key.');
  } else if (!publishableKey.startsWith('sb_publishable_')) {
    throw new Error('Use a Supabase publishable or anon key.');
  }
  supabaseUrl = url.origin;
}

const manifest = JSON.parse(await readFile('manifest.json', 'utf8'));
if (supabaseUrl) {
  const url = new URL(supabaseUrl);
  manifest.host_permissions = [...(manifest.host_permissions ?? []), `${url.protocol}//${url.hostname}/*`];
}


const extensionFiles = ['styles.css', 'chat.html', 'chat.css', 'settings.html', 'settings.css', 'assets/threadly-mark.png'];
await mkdir('dist/assets', { recursive: true });
await Promise.all([
  build({
    entryPoints: ['chat.js', 'content.js', 'settings.js', 'invite-bridge.js'],
    bundle: true,
    platform: 'browser',
    target: 'chrome120',
    format: 'iife',
    outdir: 'dist',
    define: {
      SUPABASE_URL: JSON.stringify(supabaseUrl),
      SUPABASE_PUBLISHABLE_KEY: JSON.stringify(publishableKey ?? ''),
    },
  }),
  writeFile('dist/manifest.json', `${JSON.stringify(manifest, null, 2)}\n`),
  ...extensionFiles.map((file) => copyFile(file, `dist/${file}`)),
]);
