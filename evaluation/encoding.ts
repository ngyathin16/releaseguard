import assert from 'node:assert/strict';
import { z } from 'zod';
import { policySchema } from '../src/domain.ts';
import type { Policy, RequestObservation, Stage } from '../src/domain.ts';

export const compactSchema = z.object({ encoding: z.literal('paired-simulation-v1'), case: z.string(),
  stage: z.union([z.literal(0), z.literal(1), z.literal(2)]), policy: policySchema,
  checkpoints: z.array(z.number()), pairs: z.array(z.tuple([z.string(), z.number(), z.number(), z.number().int().min(0).max(3)])) });
type Input = { case: string; stage: Stage; policy: Policy; observations: RequestObservation[]; checkpoints: number[] };

export function decode(input: z.infer<typeof compactSchema>): Input {
  const observations = input.pairs.flatMap(([cohort, baselineMs, candidateMs, errors], i) =>
    (['baseline', 'candidate'] satisfies ('baseline' | 'candidate')[]).map((arm, index): RequestObservation => ({
      id: `${input.case}-${input.stage}-${i}-${arm}`, stage: input.stage, arm, cohort, route: '/catalogue',
      startedAt: '2026-11-17T00:00:00.000Z', startedMonoMs: i * 1000, durationMs: index ? candidateMs : baselineMs,
      status: errors & (1 << index) ? 503 : 200, failed: Boolean(errors & (1 << index)), timeout: false,
      missing: false, warmup: false, version: `${arm}-simulation`, generation: input.stage + 1,
    })));
  return { case: input.case, stage: input.stage, policy: input.policy, checkpoints: input.checkpoints, observations };
}

export function encode(input: Input): z.infer<typeof compactSchema> {
  const pairs: [string, number, number, number][] = [];
  for (let i = 0; i < input.observations.length; i += 2) {
    const baseline = input.observations[i]; const candidate = input.observations[i + 1];
    if (baseline.durationMs === null || candidate.durationMs === null) throw new Error('Simulation encoding requires measured durations');
    pairs.push([baseline.cohort, baseline.durationMs, candidate.durationMs, Number(baseline.failed) + 2 * Number(candidate.failed)]);
  }
  const encoded = { encoding: 'paired-simulation-v1', case: input.case, stage: input.stage, policy: input.policy,
    checkpoints: input.checkpoints, pairs } satisfies z.infer<typeof compactSchema>;
  assert.deepEqual(decode(encoded), input, 'The compact encoding must preserve every recorded field exactly');
  return encoded;
}
