import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import path from 'node:path';
import { Runtime } from '../src/runtime.ts';
import { DEFAULT_POLICY } from '../src/domain.ts';
import { analyze } from '../src/analysis.ts';

mkdirSync('data/tests', { recursive: true });
const policy = { ...DEFAULT_POLICY, baselineErrorMax: 0.1, baselineSlowMax: 0.2, errorTolerance: 0.2, slowTolerance: 0.3, minimumPerCohort: 100, checkpoints: [200], stageTimeoutMs: 10000, telemetryGraceMs: 100, leaseMs: 500 };
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function finish(runtime: Runtime, timeout = 30000) {
  const start = Date.now();
  while (runtime.active && ['running', 'stopping', 'prepared'].includes(runtime.active.state)) {
    if (Date.now() - start > timeout) throw new Error('Run did not finish');
    await pause(50);
  }
  assert.ok(runtime.active); return runtime.active;
}
function make() { return new Runtime(path.join(mkdtempSync(path.resolve('data/tests/runtime-')), 'run.sqlite')); }

test('real HTTP healthy candidate passes all three stages only after explicit fenced advances', { timeout: 30000 }, async () => {
  const runtime = make(); await runtime.init();
  try {
    await runtime.create('healthy', 42, policy);
    for (const stage of [0, 1, 2]) {
      const run = await finish(runtime);
      assert.equal(run.stage, stage); assert.equal(run.decision?.status, 'eligible to advance');
      if (stage < 2) {
        assert.equal(run.state, 'held'); const generation = run.generation;
        await runtime.advance(run.id, generation);
        await assert.rejects(runtime.advance(run.id, generation), /Advance requires/);
      } else { assert.equal(run.state, 'completed'); assert.ok(run.rollback); }
    }
    const run = runtime.active; assert.ok(run?.decision);
    const replay = analyze(run.policy, run.observations, { stage: run.stage, checkpoint: run.decision.checkpoint, controlResolved: true, workloadComparable: true, telemetryFresh: true });
    assert.deepEqual(replay, run.decision);
    assert.equal(run.observations.filter(row => row.diagnostic).length, 3);
    assert.ok(run.observations.some(row => row.arm === 'stable' && !row.warmup));
  } finally { await runtime.close(); }
});

for (const scenario of ['missing-metrics', 'insufficient-traffic', 'unbalanced-workload', 'unhealthy-baseline', 'candidate-crash', 'lease-expiry']) {
  test(`real ${scenario} never advances and verifies withdrawal`, { timeout: 30000 }, async () => {
    const runtime = make(); await runtime.init();
    try {
      await runtime.create(scenario, 17, { ...policy, stageTimeoutMs: scenario === 'insufficient-traffic' ? 1000 : 10000 });
      const run = await finish(runtime);
      assert.equal(run.state, 'rolled back'); assert.notEqual(run.decision?.status, 'eligible to advance');
      assert.ok(run.rollback); assert.ok(run.rollback.elapsedMs < 2000);
      const generation = run.generation; await runtime.stop(); assert.equal(run.generation, generation);
      await assert.rejects(runtime.advance(run.id, generation), /Advance requires/);
      const state = await runtime.observed(); assert.equal(state.enabled, false);
      mkdirSync('docs/evidence/runtime-tests', { recursive: true });
      writeFileSync(`docs/evidence/runtime-tests/${scenario}.json.gz`, gzipSync(JSON.stringify({ policyPurpose: 'Reduced sample count boundary test; not a statistical acceptance run.', run })));
    } finally { await runtime.close(); }
  });
}

test('restart reconciles a surviving router and confirms baseline request versions', { timeout: 30000 }, async () => {
  const runtime = make(); await runtime.init();
  await runtime.create('healthy', 61, policy); await finish(runtime);
  assert.equal(runtime.active?.state, 'held');
  await runtime.stopHeartbeat();
  const database = runtime.store.db.location();
  assert.ok(database);
  runtime.store.close();
  const restarted = new Runtime(database);
  try {
    await restarted.init();
    assert.equal(restarted.active?.state, 'interrupted');
    assert.ok(restarted.active?.rollback);
    assert.equal((await restarted.observed()).enabled, false);
    assert.ok(restarted.active?.observations.filter(row => row.diagnostic).every(row => row.version === 'catalogue-stable-v1'));
  } finally { await restarted.close(); }
});

test('a delayed advance acknowledgement cannot revive a stopped run', { timeout: 30000 }, async () => {
  const runtime = make(); await runtime.init();
  try {
    await runtime.create('healthy', 73, policy); const run = await finish(runtime);
    const original = runtime.command.bind(runtime);
    let acknowledged: () => void = () => {};
    let release: () => void = () => {};
    const reached = new Promise<void>(resolve => { acknowledged = resolve; });
    const delayed = new Promise<void>(resolve => { release = resolve; });
    runtime.command = async (action, generation, target) => {
      const result = await original(action, generation, target);
      if (action === 'start') { acknowledged(); await delayed; }
      return result;
    };
    const generation = run.generation;
    const advance = runtime.advance(run.id, generation);
    await reached;
    await runtime.stop(); const stoppedGeneration = run.generation;
    release(); await assert.rejects(advance, /superseded/);
    assert.equal(run.state, 'rolled back'); assert.equal(run.generation, stoppedGeneration);
    assert.equal((await runtime.observed()).enabled, false);
    await assert.rejects(original('start', generation, run), /rejected/);
  } finally { await runtime.close(); }
});

for (const seed of [101, 202, 303]) test(`duplicate and stale control commands remain fenced ${seed}`, { timeout: 30000 }, async () => {
  const runtime = make(); await runtime.init();
  try {
    await runtime.create('healthy', seed, policy); const run = await finish(runtime); const generation = run.generation;
    const commands = await Promise.allSettled([runtime.advance(run.id, generation), runtime.advance(run.id, generation)]);
    assert.equal(commands.filter(command => command.status === 'fulfilled').length, 1);
    await finish(runtime); assert.equal(run.stage, 1);
    await Promise.all([runtime.stop(), runtime.stop(), runtime.stop()]);
    assert.equal(run.events.filter(event => event.type === 'stop requested').length, 1);
    await assert.rejects(runtime.advance(run.id, generation), /Advance requires/);
    await assert.rejects(runtime.command('start', run.generation, run), /rejected/);
    assert.equal((await runtime.observed()).enabled, false);
    mkdirSync('docs/evidence/repeated-controls', { recursive: true });
    writeFileSync(`docs/evidence/repeated-controls/run-${seed}.json.gz`, gzipSync(JSON.stringify({ format: 'releaseguard-evidence-v1', mode: 'live HTTP control race', run })));
  } finally { await runtime.close(); }
});

test('authenticated malformed lease commands cannot disable router expiry', { timeout: 15000 }, async () => {
  const runtime = make(); await runtime.init();
  try {
    await runtime.create('healthy', 79, policy); const run = await finish(runtime); const stack = runtime.stack; assert.ok(stack);
    for (const leaseMs of [null, 'not-a-number', 0, 5001]) {
      const response: Response = await fetch(`http://127.0.0.1:${stack.port}/control`, { method: 'POST', headers: { authorization: stack.token }, body: JSON.stringify({ action: 'renew', expectedGeneration: run.generation, runId: run.id, leaseMs }) });
      assert.equal(response.status, 400);
    }
    assert.equal((await runtime.observed()).enabled, true);
  } finally { await runtime.close(); }
});
