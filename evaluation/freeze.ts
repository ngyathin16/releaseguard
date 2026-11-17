import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { DEFAULT_POLICY } from '../src/domain.ts';

const version = Number(process.argv[2] ?? '1');
if (![1, 2].includes(version)) throw new Error('Use an explicitly reviewed manifest version');
const destination = new URL(`./manifest${version === 1 ? '' : '-v2'}.json`, import.meta.url);
if (existsSync(destination)) throw new Error('The frozen manifest already exists; use a new version rather than overwrite it.');
const cases = [];
for (let i = 0; i < 200; i++) cases.push({ id: `healthy-${i + 1}`, family: 'no-regression', seed: 910000 + i,
  distribution: ['uniform', 'exponential', 'mixture'][i % 3], mobileShare: [0.3, 0.5, 0.7][i % 3],
  baselineError: [0, 0.0002, 0.0005][i % 3], baselineSlow: [0.001, 0.003, 0.005][i % 3],
  errorIncrease: 0, slowIncrease: 0, affected: 'overall', blockSize: 1 });
for (let i = 0; i < 100; i++) cases.push({ id: `regression-${i + 1}`, family: 'above-tolerance', seed: 920000 + i,
  distribution: ['uniform', 'exponential', 'mixture'][i % 3], mobileShare: [0.3, 0.5, 0.7][i % 3],
  baselineError: 0.0002, baselineSlow: 0.003,
  errorIncrease: i % 2 === 0 ? 0.08 : 0, slowIncrease: i % 2 ? 0.12 : 0,
  affected: i % 4 < 2 ? 'overall' : 'mobile', blockSize: 1 });
for (let i = 0; i < 60; i++) cases.push({ id: `boundary-${i + 1}`, family: 'boundary', seed: 930000 + i,
  distribution: ['uniform', 'exponential', 'mixture'][i % 3], mobileShare: 0.5,
  baselineError: 0, baselineSlow: 0,
  errorIncrease: i < 30 ? [0.009, 0.01, 0.011][i % 3] : 0,
  slowIncrease: i >= 30 ? [0.019, 0.02, 0.021][i % 3] : 0, affected: 'overall', blockSize: 1 });
for (let i = 0; i < 40; i++) cases.push({ id: `correlated-${i + 1}`, family: 'correlated-stress', seed: 940000 + i,
  distribution: ['uniform', 'exponential', 'mixture'][i % 3], mobileShare: 0.5,
  baselineError: 0.001, baselineSlow: 0.005, errorIncrease: 0, slowIncrease: 0, affected: 'overall', blockSize: 20 });
for (const spec of cases) spec.seed += (version - 1) * 1000000;
const manifest = { version, frozenAt: new Date().toISOString(),
  purpose: 'Synthetic binomial validation; these are not HTTP measurements or production guarantees.',
  assumptions: 'Independent seeded Bernoulli outcomes within arms and cohorts, except separately reported block-correlated stress. Predetermined balanced cohort pairs; monotonic artificial timing. Conditional latency draws below/above 300ms from three distributions. Each run evaluates all three stages unless a regression or final inconclusive stage ends it.',
  pilot: 'Analytic zero-event Clopper-Pearson bound at n=800: 0.009907525833125848 with tail alpha=0.05/144. This establishes feasible healthy first-checkpoint precision before evaluation.',
  policy: DEFAULT_POLICY, cases };
mkdirSync(new URL('./results/', import.meta.url), { recursive: true });
const bytes = JSON.stringify(manifest, null, 2) + '\n';
writeFileSync(destination, bytes);
writeFileSync(new URL(`./manifest${version === 1 ? '' : '-v2'}.sha256`, import.meta.url), createHash('sha256').update(bytes).digest('hex') + '\n');
process.stdout.write(`Frozen ${cases.length} cases before evaluating them.\n`);
