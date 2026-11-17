# Evaluation evidence

These are synthetic statistical simulations, separate from the application's real HTTP scenario captures. The v2 manifest was frozen before its first execution and contains 200 no-regression runs, 100 prespecified large-effect regressions, 60 near-tolerance cases and 40 block-correlated stress cases. Its SHA-256 is checked before evaluation. Cases use three latency distributions and mobile cohort shares of 30%, 50% and 70%. Each run progresses through three stages only when the preceding stage is eligible; an inconclusive final checkpoint or regression ends the run.

The large effects are +8 percentage points of failures or +12 percentage points of slow requests, affecting all requests or just mobile. These are well above the 1/2 percentage point tolerances. Boundary cases separately use 0.9/1.0/1.1 percentage point failure increases and 1.9/2.0/2.1 percentage point slow increases. Detection targets are not applied to barely distinguishable boundary cases.

## Recorded v2 results

| Family | Eligible through all stages | Regression detected | Inconclusive | Total |
| --- | ---: | ---: | ---: | ---: |
| No regression | 135 | 0 | 65 | 200 |
| Above-tolerance regression | 0 | 100 | 0 | 100 |
| Boundary | 0 | 0 | 60 | 60 |
| Correlated stress | 6 | 0 | 34 | 40 |

The requested simulation gates pass: **0/200 false regression flags, 100/100 large-effect detections and 0/100 false advancements**. Exact two-sided 95% binomial intervals are [0%, 1.83%] for false regression, [96.38%, 100%] for large-effect detection and [0%, 3.62%] for false advancement. These finite-sample observations do not prove a universal error guarantee.

The healthy completion rate is **135/200 (67.5%; 95% interval 60.53–73.94%)**, with 65/200 inconclusive. Conservative baseline-health bounds and per-cohort sample requirements cost useful decisions, especially at the smaller cohort's 30% allocation. The application must not market this as every healthy service passing. The zero-error, balanced live fixture has a different, analytically feasible precision profile.

Every boundary case is inconclusive. The unadjusted overall point-threshold comparison declares 36 boundary cases eligible and 24 regressions on those same captured inputs; it lacks the simultaneous uncertainty guarantee. On the independent no-regression suite, it declares all 200 eligible, whereas the cohort-aware method holds 65. On large effects, both methods detect 100. The raw report retains these comparisons, including IDs where decisions differ. The correlated suite is reported separately because the binomial independence assumption is deliberately violated; the 6/40 eligible and 34/40 inconclusive results are not included in the independent gates.

## Initial failure retained

[The initial summary](initial-v1/summary.json) records 86/100 large-effect detections, 14 inconclusive, 0/100 false advances and 0/200 false regressions. Investigation found that uncertain baseline health was suppressing otherwise established candidate regressions. Baseline health should block promotion, not erase evidence of additional candidate harm. The engine now makes that distinction, with a dedicated regression test. It also derives aggregate intervals from cohort bounds to respect the stratified workload.

The v1 manifest, source snapshot, raw inputs and full judgments remain in `initial-v1/`. They are now regression evidence. The v2 seeds differ by one million; distributions and effect-size choices remain unchanged. V2 tests fresh random outcomes under the same synthetic scenarios, not unseen real-world workload families. No parameter or result was removed to improve a denominator.

## Reproduce

```powershell
npm ci
npm run check
node --test test/analysis.test.ts
node evaluation/run.ts
node evaluation/verify-recording.ts
```

`run.ts` verifies `manifest-v2.sha256`, executes every scheduled case, preserves all outcomes and exits unsuccessfully if a gate fails. It overwrites the reproducible v2 result files; the immutable v1 archive stays intact. `verify-recording.ts` re-analyzes every recorded checkpoint from retained raw inputs and compares exact full judgments.

To regenerate the independent numerical references, use Python with SciPy 1.17.1 and run `python evaluation/reference.py`. The checked-in reference JSON allows ordinary tests without installing Python/SciPy. The reference generator calls SciPy directly and never imports the ReleaseGuard engine. The original verification used Python 3.14.2, SciPy 1.17.1 and Node 24.14.0 on Windows.

Files:

- `manifest-v2.json` and `.sha256`: frozen cases, seeds, distributions, assumptions, policy and analytic pilot.
- `results/summary.json`: counts, exact 95% uncertainty intervals, gate results and comparisons.
- `results/simulation-results.json.gz`: every checkpoint's full judgment.
- `results/inputs.ndjson.gz`: every observed synthetic request in a lossless paired encoding.
- `reference.json`: 108 independent binomial interval references.
- `initial-v1/`: initial failure evidence and its exact analysis source.

The compact input format is `paired-simulation-v1`. Each tuple records `[cohort, baseline duration, candidate duration, failure bits]`; bit 0 is baseline failure and bit 1 candidate failure. Its enclosing record supplies case, stage, policy and evaluated checkpoints. IDs, synthetic monotonic start times, fixed route, status code and version identifiers are reconstructed by the documented `decode` function in `encoding.ts`. Encoding asserts deep equality with every original field, so compression does not discard outcomes or precision. These synthetic inputs contain no missing/timeout records; those boundaries are covered by runtime tests and their real HTTP captures.

There was no human usability study or independent human statistical review. These automated evaluations do not substitute for either.
