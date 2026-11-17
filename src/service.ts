import http from 'node:http';
import { createHash, randomUUID } from 'node:crypto';

const arm = process.env.RG_ARM ?? 'baseline';
const scenario = process.env.RG_SCENARIO ?? 'healthy';
const version = arm === 'candidate' ? 'catalogue-candidate-v1' : 'catalogue-stable-v1';
const fingerprint = createHash('sha256').update(JSON.stringify({ version, scenario, arm })).digest('hex');
const instance = randomUUID();
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname === '/health') { res.end(JSON.stringify({ version, fingerprint, arm, instance })); return; }
  if (url.pathname === '/shutdown' && req.method === 'POST' && req.headers.authorization === process.env.RG_TOKEN) { res.end(); server.close(); setTimeout(() => process.exit(0), 50); return; }
  if (url.pathname !== '/catalogue') { res.writeHead(404).end(); return; }
  const cohort = url.searchParams.get('cohort');
  const draw = Number(url.searchParams.get('draw') ?? '0');
  let delay = 0;
  let status = 200;
  if (scenario === 'unhealthy-baseline') status = draw < 0.2 ? 503 : 200;
  if (arm === 'candidate') {
    if (scenario === 'broad-latency') delay = 360;
    if (scenario === 'tail-latency' && draw < 0.12) delay = 360;
    if (scenario === 'cohort-regression' && cohort === 'mobile' && draw < 0.25) delay = 360;
    if (scenario === 'configuration-errors' && draw < 0.15) status = 503;
    if (scenario === 'candidate-crash') { req.socket.destroy(); return; }
  }
  if (delay) await new Promise(resolve => setTimeout(resolve, delay));
  res.writeHead(status, { 'content-type': 'application/json', 'x-release-version': version });
  res.end(JSON.stringify({ version, fingerprint, arm, items: [{ id: 1, name: 'Field notebook', price: 12 }] }));
});
server.listen(0, '127.0.0.1', () => {
  const address = server.address();
  if (address && typeof address !== 'string') process.send?.({ port: address.port, version, fingerprint, instance, pid: process.pid });
});
