import http from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { Runtime, scenarios } from './runtime.ts';
import { DEFAULT_POLICY, parsePolicy } from './domain.ts';

const port = Number(process.env.PORT ?? 4318);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be a valid local port');
const runtime = new Runtime(process.env.RG_DATABASE ?? path.resolve('data/releaseguard.sqlite'));
await runtime.init();
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist');
const createSchema = z.object({ scenario: z.string().refine(value => scenarios.some(scenario => scenario.id === value), 'Unknown bundled scenario'), seed: z.number().int().min(0).max(4294967295), policy: z.unknown().optional() }).strict();
const advanceSchema = z.object({ generation: z.number().int().min(0) }).strict();
const server = http.createServer(async (req, res) => {
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('cache-control', 'no-store');
  res.setHeader('content-security-policy', "default-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'");
  const json = (status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)); };
  if (req.headers.host !== `127.0.0.1:${port}` && req.headers.host !== `localhost:${port}`) { json(403, { error: 'Use the loopback application address.' }); return; }
  if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) { json(403, { error: 'Cross-origin requests are not permitted.' }); return; }
  try {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    if (url.pathname === '/api/state' && req.method === 'GET') { json(200, runtime.state()); return; }
    const runMatch = /^\/api\/runs\/([a-f0-9-]{36})(?:\/(export|advance|stop))?$/.exec(url.pathname);
    if (runMatch && req.method === 'GET') {
      const run = runtime.active?.id === runMatch[1] ? runtime.active : runtime.store.get(runMatch[1] ?? '');
      if (!run) { json(404, { error: 'Run not found.' }); return; }
      if (runMatch[2] === 'export') {
        res.setHeader('content-disposition', `attachment; filename="releaseguard-${run.id}.json"`);
        json(200, { format: 'releaseguard-evidence-v1', capturedAt: new Date().toISOString(), mode: 'live HTTP capture', reproduction: 'npm run reanalyze -- <this-file.json>', run });
      } else if (!runMatch[2]) json(200, runtime.publicRun(run));
      else json(404, { error: 'Route not found.' }); return;
    }
    if (req.method === 'POST') {
      if (req.headers['content-type']?.split(';')[0] !== 'application/json') { json(415, { error: 'Send application/json.' }); return; }
      let body = ''; for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body) > 64000) { json(413, { error: 'Request is too large.' }); return; } }
      const input: unknown = JSON.parse(body || '{}');
      if (url.pathname === '/api/runs') {
        const fields = createSchema.parse(input);
        json(201, await runtime.create(fields.scenario, fields.seed, fields.policy === undefined ? DEFAULT_POLICY : parsePolicy(fields.policy))); return;
      }
      if (url.pathname === '/api/reset') { await runtime.reset(); json(200, runtime.state()); return; }
      if (runMatch?.[2] === 'advance') { const fields = advanceSchema.parse(input); json(200, await runtime.advance(runMatch[1] ?? '', fields.generation)); return; }
      if (runMatch?.[2] === 'stop') {
        if (runtime.active?.id !== runMatch[1]) { json(409, { error: 'Only the active run can be stopped.' }); return; }
        await runtime.stop(); json(200, runtime.publicRun(runtime.active)); return;
      }
      json(404, { error: 'Route not found.' }); return;
    }
    if (url.pathname.startsWith('/api/')) { json(404, { error: 'Route not found.' }); return; }
    if (req.method !== 'GET') { json(405, { error: 'Method not allowed.' }); return; }
    const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    const file = path.resolve(root, relative || 'index.html');
    if (!file.startsWith(root + path.sep)) { json(403, { error: 'Path is outside the application.' }); return; }
    if (!existsSync(file) || !statSync(file).isFile()) { json(404, { error: 'Build the interface with npm run build before opening it.' }); return; }
    const mime: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png' };
    res.writeHead(200, { 'content-type': mime[path.extname(file)] ?? 'application/octet-stream' }); res.end(readFileSync(file));
  } catch (error) {
    json(error instanceof z.ZodError || error instanceof SyntaxError ? 400 : 409, { error: error instanceof Error ? error.message : String(error) });
  }
});
server.listen(port, '127.0.0.1', () => process.stdout.write(`ReleaseGuard: http://127.0.0.1:${port}\n`));
for (const signal of ['SIGINT', 'SIGTERM'] satisfies NodeJS.Signals[]) process.on(signal, () => { server.close(); void runtime.close().finally(() => process.exit(0)); });
