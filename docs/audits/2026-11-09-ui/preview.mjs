// Isolated current-source mock preview when the installed Vite runtime cannot start.
// Run from repository root: node docs/audits/2026-11-09-ui/preview.mjs
// Only writes temporary files; does not modify product source or installed dependencies.
import { build } from 'esbuild';
import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { resolve, extname } from 'node:path';
const dir = '/tmp/ehf-current-ui-audit';
mkdirSync(dir, { recursive: true });
const result = await build({ entryPoints: ['apps/web/src/main.tsx'], outdir: dir, bundle: true, splitting: true,
  format: 'esm', platform: 'browser', jsx: 'automatic', loader: { '.woff2': 'file', '.png': 'file' },
  define: { 'import.meta.env.VITE_API_MODE': '"mock"', 'import.meta.env.DEV': 'true', 'process.env.NODE_ENV': '"development"' }, metafile: true,
  plugins: [{name:'vite-url-import', setup(api) {
    api.onResolve({filter:/\?url$/}, async args => {
      const found = await api.resolve(args.path.slice(0,-4), {resolveDir:args.resolveDir,kind:args.kind});
      return {path:found.path,namespace:'url-file'};
    });
    api.onLoad({filter:/.*/,namespace:'url-file'}, args => ({contents:readFileSync(args.path),loader:'file'}));
  }}] });
writeFileSync(dir + '/meta.json', JSON.stringify(result.metafile));
writeFileSync(dir + '/index.html', readFileSync('apps/web/index.html', 'utf8').replace('/src/main.tsx', '/main.js').replace('</head>', '<link rel="stylesheet" href="/main.css"></head>'));
const req = createRequire(resolve('packages/ui-mock/package.json'));
writeFileSync(dir + '/mockServiceWorker.js', readFileSync(req.resolve('msw/mockServiceWorker.js')));
mkdirSync(dir + '/icons', {recursive:true});
for (const file of readdirSync('apps/web/icons')) writeFileSync(dir+'/icons/'+file, readFileSync('apps/web/icons/'+file));
const types = { '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.woff2': 'font/woff2', '.html': 'text/html' };
createServer((request, response) => {
  const path = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
  const candidate = resolve(dir, '.' + path);
  const file = candidate.startsWith(dir + '/') && existsSync(candidate) && extname(candidate) ? candidate : dir + '/index.html';
  response.setHeader('content-type', types[extname(file)] ?? 'application/octet-stream');
  response.setHeader('cache-control', 'no-store');
  response.end(readFileSync(file));
}).listen(5299, '127.0.0.1', () => console.log('CURRENT CHECKOUT audit preview http://127.0.0.1:5299; source: ' + process.cwd()));
