import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { z } from 'zod';
import { analyze, binomialInterval } from '../src/analysis.ts';
import { DEFAULT_POLICY, parsePolicy } from '../src/domain.ts';
import type { AnalysisContext, RequestObservation } from '../src/domain.ts';

const context: AnalysisContext = { stage: 0, checkpoint: 1600, telemetryFresh: true, workloadComparable: true, controlResolved: true };
function healthy(): RequestObservation[] {
  return Array.from({ length: 3200 }, (_, i) => ({ id: String(i), stage: 0,
    arm: i % 2 ? 'candidate' : 'baseline', cohort: Math.floor(i / 2) % 2 ? 'desktop' : 'mobile',
    route: '/catalogue', startedAt: '2026-11-17T00:00:00Z', startedMonoMs: Math.floor(i / 2) * 2,
    durationMs: 5, status: 200, failed: false, timeout: false, missing: false, warmup: false,
    version: i % 2 ? 'candidate-v1' : 'baseline-v1', generation: 1 }));
}

test('Clopper-Pearson intervals agree with independently generated SciPy references', () => {
  const reference = z.object({ cases: z.array(z.object({ k: z.number(), n: z.number(), tailAlpha: z.number(), lower: z.number(), upper: z.number() })) })
    .parse(JSON.parse(readFileSync(new URL('../evaluation/reference.json', import.meta.url), 'utf8')));
  for (const row of reference.cases) {
    const actual = binomialInterval(row.k, row.n, row.tailAlpha);
    assert.ok(Math.abs(actual.lower - row.lower) < 1e-9, JSON.stringify({ row, actual }));
    assert.ok(Math.abs(actual.upper - row.upper) < 1e-9, JSON.stringify({ row, actual }));
  }
});
test('healthy matched evidence is eligible at the frozen first checkpoint', () => {
  assert.equal(analyze(DEFAULT_POLICY, healthy(), context).status, 'eligible to advance');
});
test('a cohort regression cannot hide inside a healthy aggregate', () => {
  const rows = healthy();
  for (let i = 0; i < 120; i++) { rows[i * 4 + 1].failed = true; rows[i * 4 + 1].status = 500; }
  const decision = analyze(DEFAULT_POLICY, rows, context);
  assert.equal(decision.status, 'regression detected');
  assert.ok(decision.checks.some(check => check.cohort === 'mobile' && check.status === 'regression'));
});
test('missing, underpowered, unbalanced, stale and unresolved evidence never advances', () => {
  const missing = healthy(); missing[0].missing = true;
  const duplicated = healthy(); duplicated[0].id = duplicated[1].id;
  const unbalanced = healthy(); unbalanced.filter(row => row.arm === 'candidate').slice(0, 500).forEach(row => { row.cohort = 'desktop'; });
  for (const rows of [[], missing, duplicated, unbalanced, healthy().slice(0, 1000)]) {
    assert.equal(analyze(DEFAULT_POLICY, rows, context).status, 'inconclusive');
  }
  for (const override of [{ telemetryFresh: false }, { workloadComparable: false }, { controlResolved: false }, { checkpoint: 1599 }]) {
    assert.equal(analyze(DEFAULT_POLICY, healthy(), { ...context, ...override }).status, 'inconclusive');
  }
});
test('a shared unhealthy dependency prevents advancement', () => {
  const rows = healthy(); rows.slice(0, 1000).forEach(row => { row.failed = true; row.status = 503; });
  const decision = analyze(DEFAULT_POLICY, rows, context);
  assert.equal(decision.status, 'inconclusive');
  assert.ok(decision.reasons.some(reason => reason.includes('baseline')));
});
test('baseline uncertainty blocks promotion without hiding a proven candidate regression', () => {
  const rows = healthy(); rows[0].failed = true; rows[0].status = 500;
  for (let i = 0; i < 200; i++) { rows[i * 4 + 1].failed = true; rows[i * 4 + 1].status = 500; }
  const decision = analyze(DEFAULT_POLICY, rows, context);
  assert.equal(decision.status, 'regression detected');
  assert.ok(decision.reasons.some(reason => reason.includes('baseline')));
});
test('timeouts count as failed and slow; completed-only p95 excludes censored duration', () => {
  const rows = healthy(); Object.assign(rows[1], { timeout: true, failed: true, status: null, durationMs: 1000 });
  const candidate = analyze(DEFAULT_POLICY, rows, context).metrics.find(metric => metric.arm === 'candidate' && metric.cohort === 'overall');
  assert.equal(candidate?.failed, 1); assert.equal(candidate?.slow.count, 1);
  assert.equal(candidate?.p95CompletedMs, 5); assert.equal(candidate?.censored, 1);
});
test('warmup and stable traffic do not enter the comparison', () => {
  const rows = healthy();
  rows.push({ ...rows[0], id: 'warmup', warmup: true, failed: true });
  rows.push({ ...rows[0], id: 'stable', arm: 'stable', failed: true });
  assert.equal(analyze(DEFAULT_POLICY, rows, context).status, 'eligible to advance');
});
test('policy rejects unplanned cohorts and unsafe inference settings', () => {
  for (const bad of [{ alpha: 0.2 }, { cohorts: ['overall'] }, { checkpoints: [2000, 1000] }, { telemetryGraceMs: 5001 }]) {
    assert.throws(() => parsePolicy({ ...DEFAULT_POLICY, ...bad }));
  }
});
