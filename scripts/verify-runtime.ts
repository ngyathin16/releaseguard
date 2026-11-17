import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import path from 'node:path';
import assert from 'node:assert/strict';
import { Runtime, scenarios } from '../src/runtime.ts';
import { DEFAULT_POLICY } from '../src/domain.ts';
import { analyze } from '../src/analysis.ts';

mkdirSync('data/runtime-verification', { recursive: true });
const outputDirectory = process.env.RG_VERIFY_OUTPUT ?? 'docs/evidence/live-runs';
mkdirSync(outputDirectory, { recursive: true });
const summary: { scenario: string; seed: number; stages: number; state: string; judgment: string | null; samples: number; withdrawalMs: number | null; replayMatched: boolean; evidence: string }[] = [];
const selected = process.argv.slice(2);
for (const scenario of scenarios.filter(scenario => !selected.length || selected.includes(scenario.id))) {
  for (const seed of [101, 202, 303]) {
    const runtime = new Runtime(path.join(mkdtempSync(path.resolve('data/runtime-verification/run-')), 'run.sqlite'));
    await runtime.init();
    try {
      await runtime.create(scenario.id, seed, { ...DEFAULT_POLICY, stageTimeoutMs: scenario.id === 'insufficient-traffic' ? 2000 : DEFAULT_POLICY.stageTimeoutMs });
      while (runtime.active && ['running', 'held', 'stopping', 'prepared'].includes(runtime.active.state)) {
        if (runtime.active.state === 'held') await runtime.advance(runtime.active.id, runtime.active.generation);
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      const run = runtime.active; assert.ok(run?.decision && run.decisionInput);
      const replay = analyze(run.policy, run.observations.slice(0, run.decisionInput.observationCount), run.decisionInput.context);
      assert.deepEqual(replay, run.decision);
      if (scenario.id === 'healthy') assert.equal(run.state, 'completed');
      else { assert.notEqual(run.decision.status, 'eligible to advance'); assert.equal(run.state, 'rolled back'); }
      assert.ok(run.rollback);
      const evidence = path.join(outputDirectory, `${scenario.id}-${seed}.json.gz`).replaceAll('\\', '/');
      writeFileSync(evidence, gzipSync(JSON.stringify({ format: 'releaseguard-evidence-v1', mode: 'live HTTP capture', run })));
      summary.push({ scenario: scenario.id, seed, stages: run.stage + 1, state: run.state, judgment: run.decision.status, samples: run.observations.length, withdrawalMs: run.rollback.elapsedMs, replayMatched: true, evidence });
      writeFileSync(path.join(outputDirectory, 'summary.json'), JSON.stringify({ capturedAt: new Date().toISOString(), policy: DEFAULT_POLICY, source: 'real independent HTTP service processes; synthetic seeded requests', incomplete: summary.length < (selected.length || scenarios.length) * 3, rows: summary }, null, 2));
      process.stdout.write(`${scenario.id} ${seed}: ${run.decision.status}; ${run.observations.length} requests; withdrawal ${run.rollback.elapsedMs.toFixed(1)} ms\n`);
    } finally { await runtime.close(); }
  }
}
