import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises';

await mkdir('dist/server', { recursive: true });
await mkdir('dist/.openai', { recursive: true });
await copyFile('dist/argue_ai/index.js', 'dist/server/index.js');
await copyFile('.openai/hosting.json', 'dist/.openai/hosting.json');
await rm('dist/argue_ai', { recursive: true, force: true });
await rm('dist/assets', { recursive: true, force: true });
await rm('dist/index.html', { force: true });
await rm('dist/wrangler.json', { force: true });
await writeFile('dist/wrangler.json', `${JSON.stringify({
  $schema: './node_modules/wrangler/config-schema.json',
  name: 'argue-ai',
  main: './server/index.js',
  compatibility_date: '2026-07-07',
  compatibility_flags: ['nodejs_compat'],
  assets: {
    directory: './client',
    binding: 'ASSETS',
    not_found_handling: 'single-page-application',
  },
}, null, 2)}\n`);
