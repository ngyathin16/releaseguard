import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createWriteStream, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { createGzip, gzipSync } from 'node:zlib';
import { z } from 'zod';
import { ANALYSIS_VERSION, analyze, binomialInterval } from '../src/analysis.ts';
import { policySchema } from '../src/domain.ts';
import type { Judgment, Policy, RequestObservation, Stage } from '../src/domain.ts';
import { encode } from './encoding.ts';

const caseSchema = z.object({ id: z.string(), family: z.enum(['no-regression', 'above-tolerance', 'boundary', 'correlated-stress']),
  seed: z.number().int(), distribution: z.enum(['uniform', 'exponential', 'mixture']), mobileShare: z.number(),
  baselineError: z.number(), baselineSlow: z.number(), errorIncrease: z.number(), slowIncrease: z.number(),
  affected: z.enum(['overall', 'mobile']), blockSize: z.number().int() });
const manifestBytes = readFileSync(new URL('./manifest-v2.json', import.meta.url));
const manifestHash = createHash('sha256').update(manifestBytes).digest('hex');
assert.equal(manifestHash, readFileSync(new URL('./manifest-v2.sha256', import.meta.url), 'utf8').trim(), 'Frozen evaluation manifest changed');
const manifest = z.object({ policy: policySchema, cases: z.array(caseSchema) }).parse(JSON.parse(manifestBytes.toString()));
const output = new URL('./results/', import.meta.url);
mkdirSync(output, { recursive: true });
const compressed = createGzip();
const compressionDone = pipeline(compressed, createWriteStream(new URL('inputs.ndjson.gz', output)));
const results: { id: string; family: string; status: Judgment['status']; finalStage: Stage;
  overallThresholdStatus: string; judgments: Judgment[] }[] = [];

function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6D2B79F5;
    let value = Math.imul(state ^ state >>> 15, state | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
}

function observations(spec: z.infer<typeof caseSchema>, stage: Stage, policy: Policy): RequestObservation[] {
  const rng = random(spec.seed + stage * 10000000);
  const rows: RequestObservation[] = [];
  const count = Math.max(...policy.checkpoints);
  const cohortSchedule: string[] = Array.from({ length: count }, (_, i) => i < Math.round(count * spec.mobileShare) ? 'mobile' : 'desktop');
  for (let i = count - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [cohortSchedule[i], cohortSchedule[j]] = [cohortSchedule[j], cohortSchedule[i]]; }
  let blockError = [0, 0]; let blockSlow = [0, 0];
  for (let i = 0; i < count; i++) {
    if (i % spec.blockSize === 0) { blockError = [rng(), rng()]; blockSlow = [rng(), rng()]; }
    const cohort = cohortSchedule[i];
    for (const [armIndex, arm] of (['baseline', 'candidate'] satisfies ('baseline' | 'candidate')[]).entries()) {
      const affected = arm === 'candidate' && (spec.affected === 'overall' || cohort === spec.affected);
      const failed = blockError[armIndex] < spec.baselineError + (affected ? spec.errorIncrease : 0);
      const slow = blockSlow[armIndex] < spec.baselineSlow + (affected ? spec.slowIncrease : 0);
      const draw = rng();
      const fast = spec.distribution === 'uniform' ? 5 + draw * 40 : spec.distribution === 'exponential'
        ? Math.min(250, 5 - 25 * Math.log(Math.max(1e-12, draw))) : draw < 0.8 ? 8 + draw * 10 : 100 + draw * 100;
      rows.push({ id: `${spec.id}-${stage}-${i}-${arm}`, stage, arm, cohort, route: '/catalogue',
        startedAt: '2026-11-17T00:00:00.000Z', startedMonoMs: i * 1000,
        durationMs: slow ? 301 + draw * 500 : fast, status: failed ? 503 : 200, failed,
        timeout: false, missing: false, warmup: false, version: `${arm}-simulation`, generation: stage + 1 });
    }
  }
  return rows;
}

function threshold(decision: Judgment): string {
  const overall = decision.checks.filter(check => check.cohort === 'overall');
  if (overall.some(check => (check.baseline.estimate ?? 1) > check.baselineLimit)) return 'inconclusive';
  return overall.some(check => (check.candidate.estimate ?? 1) - (check.baseline.estimate ?? 0) > check.tolerance)
    ? 'regression detected' : 'eligible to advance';
}

for (const spec of manifest.cases) {
  const judgments: Judgment[] = [];
  let final: Judgment | undefined;
  for (const stage of [0, 1, 2] satisfies Stage[]) {
    const rows = observations(spec, stage, manifest.policy);
    for (const checkpoint of manifest.policy.checkpoints) {
      final = analyze(manifest.policy, rows.slice(0, checkpoint * 2), {
        stage, checkpoint, controlResolved: true, workloadComparable: true, telemetryFresh: true });
      judgments.push(final);
      if (final.status !== 'inconclusive') break;
    }
    assert.ok(final);
    const analyzedRows = rows.slice(0, final.checkpoint * 2);
    const input = { case: spec.id, stage, policy: manifest.policy, observations: analyzedRows,
      checkpoints: judgments.filter(judgment => judgment.stage === stage).map(judgment => judgment.checkpoint) };
    if (!compressed.write(JSON.stringify(encode(input)) + '\n')) await once(compressed, 'drain');
    if (final.status !== 'eligible to advance') break;
  }
  assert.ok(final);
  results.push({ id: spec.id, family: spec.family, status: final.status, finalStage: final.stage,
    overallThresholdStatus: threshold(final), judgments });
  if (results.length % 50 === 0) process.stdout.write(`Evaluated ${results.length}/${manifest.cases.length}\n`);
}
compressed.end();
await compressionDone;
const families = ['no-regression', 'above-tolerance', 'boundary', 'correlated-stress'];
const summary = families.map(family => {
  const selected = results.filter(result => result.family === family);
  const outcomes = ['eligible to advance', 'regression detected', 'inconclusive'].map(status => {
    const count = selected.filter(result => result.status === status).length;
    return { status, count, total: selected.length, rate: count / selected.length, uncertainty95: binomialInterval(count, selected.length) };
  });
  return { family, outcomes,
    simpleThreshold: Object.fromEntries(['eligible to advance', 'regression detected', 'inconclusive']
      .map(status => [status, selected.filter(result => result.overallThresholdStatus === status).length])),
    changedDecisions: selected.filter(result => result.status !== result.overallThresholdStatus).map(result => result.id) };
});
const report = { analysisVersion: ANALYSIS_VERSION, manifestHash, node: process.version, generatedAt: new Date().toISOString(),
  assumptions: 'Independent Bernoulli within arm/cohort except the separate correlated stress suite. Synthetic timing only. Bounds are simultaneous across all three stages, both predeclared checkpoints, outcomes, arms, cohorts including overall and tails.',
  summary, results };
writeFileSync(new URL('simulation-results.json.gz', output), gzipSync(JSON.stringify(report) + '\n'));
const gates = {
  falseRegression: results.filter(result => result.family === 'no-regression' && result.status === 'regression detected').length <= 10,
  largeEffectDetection: results.filter(result => result.family === 'above-tolerance' && result.status === 'regression detected').length >= 90,
  falseAdvancement: results.filter(result => result.family === 'above-tolerance' && result.status === 'eligible to advance').length <= 5,
};
writeFileSync(new URL('summary.json', output), JSON.stringify({ ...report, results: undefined, gates }, null, 2) + '\n');
process.stdout.write(JSON.stringify({ summary, gates }, null, 2) + '\n');
assert.ok(Object.values(gates).every(Boolean), 'A frozen simulation gate failed; retain these outcomes before revising a future suite.');
