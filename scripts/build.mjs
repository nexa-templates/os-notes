import { solidPlugin } from './solid-build.mjs';
import { mkdir, copyFile } from 'node:fs/promises';
import { build } from 'esbuild';
await mkdir('dist', { recursive: true });
for (const file of ['index.html', 'styles.css', 'favicon.svg']) await copyFile(`web/${file}`, `dist/${file}`);
await build({ entryPoints: ['web/app.js'], plugins: [solidPlugin], conditions: ['browser'], outfile: 'dist/app.js', bundle: true, minify: true, format: 'esm', target: ['es2022'], legalComments: 'eof' });
console.log('Built Notes. Deploy the Worker to enable persistent notebooks and sharing.');
