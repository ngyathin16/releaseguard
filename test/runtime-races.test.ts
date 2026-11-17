import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import path from 'node:path';
import { Runtime } from '../src/runtime.ts';
import { DEFAULT_POLICY } from '../src/domain.ts';

const policy = { ...DEFAULT_POLICY, baselineErrorMax: 0.1, baselineSlowMax: 0.2,
  errorTolerance: 0.2, slowTolerance: 0.3, minimumPerCohort: 100, checkpoints: [200], leaseMs: 3000 };
async function held(runtime: Runtime) {
  for (let i = 0; i < 400; i++) {
    if (runtime.active?.state === 'held') return runtime.active;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error('Healthy setup did not become eligible');
}
function make() {
  mkdirSync('data/tests', { recursive: true });
  return new Runtime(path.join(mkdtempSync(path.resolve('data/tests/race-')), 'run.sqlite'));
}

test('an advance paused before reading router state cannot revive a completed stop', { timeout: 30000 }, async () => {
  const runtime = make(); await runtime.init();
  try {
    await runtime.create('healthy', 1701, policy); const run = await held(runtime);
    const originalObserved = runtime.observed.bind(runtime);
    let reads = 0; let reached: () => void = () => {}; let release: () => void = () => {};
    const barrier = new Promise<void>(resolve => { reached = resolve; });
    const paused = new Promise<void>(resolve => { release = resolve; });
    runtime.observed = async () => {
      reads++;
      if (reads === 2) { reached(); await paused; }
      return originalObserved();
    };
    const advancing = runtime.advance(run.id, run.generation);
    await barrier;
    await runtime.stop();
    const stoppedGeneration = run.generation;
    release();
    await assert.rejects(advancing, /superseded|stopped|prepared|stop/i);
    assert.equal((await originalObserved()).enabled, false);
    assert.equal(run.generation, stoppedGeneration);
    assert.equal(run.state, 'rolled back');
    await assert.rejects(runtime.command('start', stoppedGeneration, run), /rejected/);
    assert.equal((await originalObserved()).enabled, false);
  } finally { await runtime.close(); }
});

test('stop reconciles a generation conflict before acknowledging withdrawal', { timeout: 30000 }, async () => {
  const runtime = make(); await runtime.init();
  try {
    await runtime.create('healthy', 1702, policy); const run = await held(runtime);
    const original = runtime.command.bind(runtime);
    let injected = false;
    runtime.command = async (action, generation, target) => {
      if (action === 'stop' && !injected) {
        injected = true;
        await original('start', generation, target);
      }
      return original(action, generation, target);
    };
    await runtime.stop();
    assert.ok(injected);
    assert.equal(run.state, 'rolled back');
    assert.ok(run.rollback);
    assert.equal((await runtime.observed()).enabled, false);
    assert.ok(run.observations.filter(row => row.diagnostic).every(row => row.version === 'catalogue-stable-v1'));
  } finally { await runtime.close(); }
});
