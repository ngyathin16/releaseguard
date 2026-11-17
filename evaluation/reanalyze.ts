import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { z } from 'zod';
import { analyze, ANALYSIS_VERSION } from '../src/analysis.ts';
import { policySchema } from '../src/domain.ts';

const stageSchema = z.union([z.literal(0), z.literal(1), z.literal(2)]);
const contextSchema = z.object({ stage: stageSchema, checkpoint: z.number().int().nonnegative(),
  controlResolved: z.boolean(), workloadComparable: z.boolean(), telemetryFresh: z.boolean() });
const inputSchema = z.object({ observationCount: z.number().int().nonnegative(), context: contextSchema });
const observationSchema = z.object({
  id: z.string(), stage: stageSchema, arm: z.enum(['baseline', 'candidate', 'stable']), cohort: z.string(),
  route: z.string(), startedAt: z.string(), startedMonoMs: z.number(), durationMs: z.number().nullable(),
  status: z.number().nullable(), failed: z.boolean(), timeout: z.boolean(), missing: z.boolean(),
  warmup: z.boolean(), version: z.string().nullable(), generation: z.number().int(), diagnostic: z.boolean().optional(),
});
const packetSchema = z.object({ format: z.literal('releaseguard-evidence-v1'), run: z.object({
  id: z.string(), policy: policySchema, observations: z.array(observationSchema),
  decision: z.unknown(), decisionInput: inputSchema.nullable(),
  judgments: z.array(z.object({ decision: z.unknown(), input: inputSchema })).optional(),
  stages: z.array(z.object({ stage: stageSchema, decision: z.unknown(), decisionInput: inputSchema.optional() })),
}) });
const filename = process.argv[2];
if (!filename) throw new Error('Usage: npm run reanalyze -- <export.json[.gz]>');
const bytes = readFileSync(filename);
const packet = packetSchema.parse(JSON.parse((filename.endsWith('.gz') ? gunzipSync(bytes) : bytes).toString('utf8')));
const run = packet.run;
const checks = [];
for (const saved of run.judgments ?? []) {
  assert.ok(saved.input.observationCount <= run.observations.length, 'Recorded checkpoint references absent observations');
  const actual = analyze(run.policy, run.observations.slice(0, saved.input.observationCount), saved.input.context);
  assert.deepEqual(actual, saved.decision, 'An intermediate recorded judgment differs');
}
for (const stage of run.stages) {
  if (!stage.decisionInput || !stage.decision) continue;
  assert.ok(stage.decisionInput.observationCount <= run.observations.length, 'Recorded decision references absent observations');
  const actual = analyze(run.policy, run.observations.slice(0, stage.decisionInput.observationCount), stage.decisionInput.context);
  assert.deepEqual(actual, stage.decision, `Stage ${stage.stage}: recorded judgment differs from ${ANALYSIS_VERSION}`);
  checks.push({ stage: stage.stage, status: actual.status, checkpoint: actual.checkpoint });
}
if (run.decisionInput && run.decision) {
  assert.ok(run.decisionInput.observationCount <= run.observations.length, 'Recorded decision references absent observations');
  const actual = analyze(run.policy, run.observations.slice(0, run.decisionInput.observationCount), run.decisionInput.context);
  assert.deepEqual(actual, run.decision, 'Final recorded judgment differs');
}
if (!checks.length) throw new Error('This export contains no recorded completed analysis to reproduce.');
process.stdout.write(JSON.stringify({ run: run.id, analysisVersion: ANALYSIS_VERSION, exactMatch: true,
  retainedCheckpoints: run.judgments?.length ?? checks.length, checks }, null, 2) + '\n');
