import http from 'node:http';
import { randomUUID } from 'node:crypto';

const ports = { stable: Number(process.env.RG_STABLE), baseline: Number(process.env.RG_BASELINE), candidate: Number(process.env.RG_CANDIDATE) };
const token = process.env.RG_TOKEN;
let generation = 0;
let stage = 0;
let enabled = false;
let leaseUntil = 0;
let runId = '';
const stoppedRuns = new Set<string>();
const instance = randomUUID();
function expire() {
  if (enabled && performance.now() > leaseUntil) { enabled = false; stoppedRuns.add(runId); generation++; }
}
const server = http.createServer(async (req, res) => {
  expire();
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname === '/shutdown' && req.method === 'POST' && req.headers.authorization === token) { enabled = false; res.end(); server.close(); setTimeout(() => process.exit(0), 50); return; }
  if (url.pathname === '/state' && req.headers.authorization === token) {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ generation, stage, enabled, runId, instance, leaseRemainingMs: Math.max(0, leaseUntil - performance.now()) })); return;
  }
  if (url.pathname === '/control' && req.method === 'POST' && req.headers.authorization === token) {
    let body = ''; for await (const chunk of req) { body += chunk; if (body.length > 4096) { res.writeHead(413).end(); return; } }
    try {
      const command = JSON.parse(body);
      if (!Number.isInteger(command.expectedGeneration) || command.expectedGeneration !== generation) { res.writeHead(409).end(JSON.stringify({ generation, enabled })); return; }
      if ((command.action === 'start' || command.action === 'renew') && (!Number.isFinite(command.leaseMs) || command.leaseMs < 500 || command.leaseMs > 5000)) { res.writeHead(400).end(JSON.stringify({ error: 'Lease must be 500–5000 milliseconds.' })); return; }
      if (command.action === 'renew') {
        if (!enabled || command.runId !== runId) { res.writeHead(409).end(); return; }
        leaseUntil = performance.now() + Math.min(5000, Math.max(100, command.leaseMs));
      } else if (command.action === 'stop') { enabled = false; stoppedRuns.add(runId); generation++; }
      else if (command.action === 'start' && Number.isInteger(command.stage) && command.stage >= 0 && command.stage <= 2 && typeof command.runId === 'string' && /^[a-f0-9-]{36}$/.test(command.runId)) {
        if (stoppedRuns.has(command.runId)) { res.writeHead(409).end(JSON.stringify({ error: 'A stopped run cannot be restarted.' })); return; }
        enabled = true; stage = command.stage; runId = command.runId; generation++;
        leaseUntil = performance.now() + Math.min(5000, Math.max(100, command.leaseMs));
      } else { res.writeHead(400).end(); return; }
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ generation, stage, enabled, runId, instance }));
    } catch { res.writeHead(400).end(); } return;
  }
  if (url.pathname !== '/catalogue') { res.writeHead(404).end(); return; }
  const allocation = [0.05, 0.25, 0.5][stage] ?? 0;
  const slot = Number(url.searchParams.get('slot'));
  // Only the bundled generator can choose slots; public probes obey the current allocation.
  const draw = req.headers.authorization === token && Number.isFinite(slot) && slot >= 0 && slot < 1 ? slot : Math.random();
  const arm = !enabled ? 'baseline' : draw < allocation ? 'baseline' : draw < allocation * 2 ? 'candidate' : 'stable';
  const observedGeneration = generation;
  const upstream = http.request({ hostname: '127.0.0.1', port: ports[arm], path: `/catalogue?cohort=${encodeURIComponent(url.searchParams.get('cohort') ?? 'desktop')}&draw=${encodeURIComponent(url.searchParams.get('draw') ?? '0.5')}`, method: 'GET', timeout: 1100 }, response => {
    res.writeHead(response.statusCode ?? 502, { ...response.headers, 'x-release-arm': arm, 'x-router-generation': String(observedGeneration) }); response.pipe(res);
  });
  upstream.on('timeout', () => upstream.destroy());
  upstream.on('error', () => { if (!res.headersSent) res.writeHead(502, { 'x-release-arm': arm, 'x-router-generation': String(observedGeneration) }); res.end(); });
  res.on('close', () => { if (!res.writableEnded) upstream.destroy(); });
  upstream.end();
});
server.listen(0, '127.0.0.1', () => { const address = server.address(); if (address && typeof address !== 'string') process.send?.({ port: address.port, instance, pid: process.pid }); });
