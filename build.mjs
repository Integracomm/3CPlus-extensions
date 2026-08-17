// build.mjs
//
// A unica coisa que precisa de bundle e o socket.io-client: o Manifest V3
// proibe carregar script remoto (CDN), entao ele tem que virar um arquivo
// local dentro da extensao.
//
// Todo o resto (service worker, side panel, content script) roda direto do
// codigo-fonte, sem transpilar. Isso mantem o ciclo editar -> recarregar
// rapido e o debug legivel no DevTools.

import * as esbuild from 'esbuild';

await esbuild.build({
  stdin: {
    contents: `import { io } from 'socket.io-client'; globalThis.io = io;`,
    resolveDir: '.',
    loader: 'js'
  },
  bundle: true,
  format: 'iife',
  target: 'chrome120',
  minify: true,
  outfile: 'vendor/socket.io.js'
});

console.log('OK  vendor/socket.io.js gerado');
