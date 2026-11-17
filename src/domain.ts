import { z } from 'zod';

export const policySchema = z.object({
  version: z.literal('1'),
  alpha: z.number().min(0.001).max(0.05),
  cohorts: z.array(z.string().regex(/^[a-z][a-z0-9-]{0,30}$/)).min(1).max(8)
    .refine(values => new Set(values).size === values.length, 'Cohorts must be unique')
    .refine(values => !values.includes('overall'), 'overall is reserved'),
  errorTolerance: z.number().positive().max(0.2),
  slowTolerance: z.number().positive().max(0.3),
  slowMs: z.number().int().min(10).max(1000),
  baselineErrorMax: z.number().positive().max(0.1),
  baselineSlowMax: z.number().positive().max(0.2),
  minimumPerCohort: z.number().int().min(20).max(10000),
  checkpoints: z.array(z.number().int().min(20).max(20000)).min(1).max(4)
    .refine(values => values.every((value, i) => i === 0 || value > values[i - 1]), 'Checkpoints must increase'),
  stageTimeoutMs: z.number().int().min(1000).max(600000),
  telemetryGraceMs: z.number().int().min(100).max(5000),
  leaseMs: z.number().int().min(500).max(5000),
  maxCohortImbalance: z.number().min(0).max(0.2),
  maxRateImbalance: z.number().min(0).max(0.3),
}).strict();

export type Policy = z.infer<typeof policySchema>;
export const DEFAULT_POLICY: Policy = {
  version: '1', alpha: 0.05, cohorts: ['desktop', 'mobile'],
  errorTolerance: 0.01, slowTolerance: 0.02, slowMs: 300,
  baselineErrorMax: 0.01, baselineSlowMax: 0.05,
  minimumPerCohort: 800, checkpoints: [1600, 3200],
  stageTimeoutMs: 120000, telemetryGraceMs: 3000, leaseMs: 3000,
  maxCohortImbalance: 0.05, maxRateImbalance: 0.15,
};

export function parsePolicy(value: unknown): Policy {
  return policySchema.parse(value);
}

export type Arm = 'baseline' | 'candidate' | 'stable';
export type Stage = 0 | 1 | 2;
export type RequestObservation = {
  id: string; stage: Stage; arm: Arm; cohort: string; route: string;
  startedAt: string; startedMonoMs: number; durationMs: number | null;
  status: number | null; failed: boolean; timeout: boolean; missing: boolean;
  warmup: boolean; version: string | null; generation: number;
  diagnostic?: boolean;
};

export type Interval = { lower: number; upper: number };
export type Rate = { count: number; total: number; estimate: number | null; interval: Interval };
export type ArmMetrics = {
  arm: 'baseline' | 'candidate'; cohort: string; attempted: number;
  completed: number; failed: number; timedOut: number; missing: number;
  error: Rate; slow: Rate; p95CompletedMs: number | null;
  censored: number; achievedRps: number | null; maxConcurrency: number;
};
export type MetricCheck = {
  cohort: string; outcome: 'error' | 'slow'; baseline: Rate; candidate: Rate;
  degradation: Interval; tolerance: number; baselineLimit: number;
  baselineHealthy: boolean; status: 'within tolerance' | 'regression' | 'uncertain';
};
export type IntegrityCheck = { name: string; passed: boolean; detail: string };
export type AnalysisContext = {
  stage: Stage; checkpoint: number; controlResolved: boolean;
  workloadComparable: boolean; telemetryFresh: boolean;
};
export type Judgment = {
  status: 'eligible to advance' | 'regression detected' | 'inconclusive';
  stage: Stage; checkpoint: number; reasons: string[]; checks: MetricCheck[];
  metrics: ArmMetrics[]; integrity: IntegrityCheck[]; method: string; tailAlpha: number;
};
