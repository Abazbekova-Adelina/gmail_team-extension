import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { zipSync } from 'fflate';

const manifest = JSON.parse(await readFile('dist/manifest.json', 'utf8'));
const configured = Boolean(manifest.host_permissions?.length);
const html = await readFile('site/index.html', 'utf8');
const visibleSection = configured ? 'data-install' : 'data-pending';
const archivePath = 'site-dist/gmail-team-chat.zip';

await mkdir('site-dist', { recursive: true });
await Promise.all([
  writeFile('site-dist/index.html', html.replace(`${visibleSection} hidden`, visibleSection)),
  copyFile('site/styles.css', 'site-dist/styles.css'),
]);

if (configured) {
  const files = ['manifest.json', 'chat.html', 'chat.js', 'chat.css', 'content.js', 'styles.css', 'assets/threadly-mark.png'];
  const entries = await Promise.all(files.map(async (file) => [file, await readFile(`dist/${file}`)]));
  await writeFile(archivePath, zipSync(Object.fromEntries(entries)));
} else {
  await rm(archivePath, { force: true });
}
