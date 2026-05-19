import * as esbuild from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';

const watch = process.argv.includes('--watch');

mkdirSync('dist', { recursive: true });

// Build the plugin code (runs in Figma's sandbox)
const codeCtx = await esbuild.context({
  entryPoints: ['src/code.ts'],
  bundle: true,
  outfile: 'dist/code.js',
  target: 'es2015',
  format: 'iife',
});

if (watch) {
  await codeCtx.watch();
  console.log('Watching for changes...');
} else {
  await codeCtx.rebuild();
  await codeCtx.dispose();
}

// Build UI HTML (inline the JS)
const uiCtx = await esbuild.context({
  entryPoints: ['src/ui.ts'],
  bundle: true,
  outfile: 'dist/ui.js',
  target: 'es2015',
  format: 'iife',
});

if (watch) {
  await uiCtx.watch();
} else {
  await uiCtx.rebuild();
  await uiCtx.dispose();

  // Inline the JS into HTML
  const js = readFileSync('dist/ui.js', 'utf-8');
  const html = readFileSync('src/ui.html', 'utf-8').replace('<!-- INLINE_SCRIPT -->', `<script>${js}</script>`);
  writeFileSync('dist/ui.html', html);
  console.log('Built dist/code.js + dist/ui.html');
}
