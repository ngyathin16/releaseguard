import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import http from 'node:http';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { DEFAULT_POLICY } from '../src/domain.ts';

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function freePort() {
  const server = net.createServer(); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const port = address.port; await new Promise<void>(resolve => server.close(() => resolve())); return port;
}
async function start(port: number, database: string, stopPause = 0) {
  const child = spawn(process.execPath, ['src/server.ts'], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PORT: String(port), RG_DATABASE: database, RG_STOP_PAUSE_MS: String(stopPause) } });
  let stderr = ''; child.stderr.on('data', data => { stderr += data; });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error(`Server failed to start: ${stderr}`)); }, 10000);
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Server exited ${code}: ${stderr}`)); });
    child.stdout.on('data', data => { if (String(data).includes('ReleaseGuard:')) { clearTimeout(timer); resolve(); } });
  });
  return child;
}
async function waitState(base: string, state: string) {
  for (let i = 0; i < 200; i++) { const body = await (await fetch(`${base}/api/state`)).json(); if (body.active?.state === state) return body.active; await pause(50); }
  throw new Error(`Did not reach ${state}`);
}
const post = (base: string, endpoint: string, body = {}) => fetch(`${base}${endpoint}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('HTTP boundary rejects unsafe origins, hosts, invalid policy, and unknown traffic targets', { timeout: 15000 }, async () => {
  mkdirSync('data/tests', { recursive: true }); const port = await freePort(); const base = `http://127.0.0.1:${port}`;
  const child = await start(port, path.join(mkdtempSync(path.resolve('data/tests/server-')), 'run.sqlite'));
  try {
    assert.equal((await fetch(`${base}/api/state`, { headers: { origin: 'https://example.com' } })).status, 403);
    const badHost = await new Promise<number | undefined>(resolve => { http.get(`${base}/api/state`, { headers: { host: 'attacker.example' } }, response => { response.resume(); resolve(response.statusCode); }); });
    assert.equal(badHost, 403);
    assert.equal((await post(base, '/api/runs', { scenario: 'https://example.com', seed: 1 })).status, 400);
    assert.equal((await post(base, '/api/runs', { scenario: 'healthy', seed: 1, policy: { ...DEFAULT_POLICY, alpha: 0.9 } })).status, 400);
    assert.equal((await fetch(`${base}/api/runs`, { method: 'POST', body: '{}' })).status, 415);
  } finally { child.kill(); }
});

for (const repetition of [1, 2, 3]) test(`kill controller during stop and recover actual baseline routing ${repetition}`, { timeout: 20000 }, async () => {
  mkdirSync('data/tests', { recursive: true }); const port = await freePort(); const base = `http://127.0.0.1:${port}`;
  const database = path.join(mkdtempSync(path.resolve('data/tests/restart-')), 'run.sqlite');
  const child = await start(port, database, 4000);
  let restarted: Awaited<ReturnType<typeof start>> | null = null;
  try {
    const response = await post(base, '/api/runs', { scenario: 'healthy', seed: repetition, policy: { ...DEFAULT_POLICY, baselineErrorMax: 0.1, baselineSlowMax: 0.2, errorTolerance: 0.2, slowTolerance: 0.3, minimumPerCohort: 100, checkpoints: [200] } });
    assert.equal(response.status, 201);
    const run = await waitState(base, 'held');
    const stopping = post(base, `/api/runs/${run.id}/stop`).catch(() => null);
    await waitState(base, 'stopping');
    const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
    child.kill('SIGKILL'); await exited; await stopping;
    restarted = await start(port, database);
    const recovered = await waitState(base, 'interrupted');
    assert.ok(recovered.rollback); assert.equal(recovered.rollback.observedVersion, 'catalogue-stable-v1');
    const stale = await post(base, `/api/runs/${run.id}/advance`, { generation: run.generation }); assert.equal(stale.status, 409);
    const exported = await (await fetch(`${base}/api/runs/${run.id}/export`)).json();
    const probes = exported.run.observations.filter((row: { diagnostic?: boolean }) => row.diagnostic);
    assert.equal(probes.length, 3); assert.ok(probes.every((row: { arm: string; version: string }) => row.arm === 'baseline' && row.version === 'catalogue-stable-v1'));
    mkdirSync('docs/evidence/controller-restart', { recursive: true });
    writeFileSync(`docs/evidence/controller-restart/run-${repetition}.json.gz`, gzipSync(JSON.stringify(exported)));
    await post(base, '/api/reset');
  } finally { if (restarted) await post(base, '/api/reset').catch(() => null); child.kill('SIGKILL'); restarted?.kill(); }
});
