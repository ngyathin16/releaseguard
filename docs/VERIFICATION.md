# Verification

17 November 2026, Asia/Hong_Kong. ReleaseGuard is a working local application with real HTTP traffic, independent analysis, persistent history, and observed control recovery. It is not a production release controller or a hosted executable backend.

## Runtime and statistical evidence

The full default-policy live suite completed **33/33 runs** across all 11 bundled scenarios, three seeds each, retaining **967,602 request observations**. Healthy candidates completed all three stages in 3/3 runs. Broad latency, tail-only latency, mobile-cohort latency and configuration errors produced 12/12 statistical regression findings. Insufficient traffic, missing metrics, unbalanced workload, an unhealthy shared dependency, candidate crashes and expired leases produced 18/18 inconclusive results, with zero advancement. The insufficient-traffic scenario explicitly freezes a two-second stage deadline to exercise exhaustion promptly.

Every run confirmed withdrawal through router acknowledgement and subsequent baseline-version requests. The slowest observed withdrawal was **329.462 ms**; **0/33** exceeded the two-second target. This measures decision-to-confirmed observation on the declared shared Windows host, excluding already in-flight requests; it is not a production latency guarantee. See [summary and all compressed raw captures](evidence/live-runs/summary.json). A separate independent replay of all 33 exports matched the recorded judgments: [reanalysis verification](evidence/reanalysis-verification.json).

The final suite has **28 behavior tests**: numerical references, exact sample boundaries, cohort comparisons, missing data, timeouts, actual HTTP service faults, input/origin/host restrictions, router expiry and fencing, delayed control races, controller restart and recovery. Controller termination during a stop and repeated/stale controls each have three real-process repetitions with retained request evidence. The fast boundary tests use an explicitly relaxed statistical policy to isolate lifecycle behavior; they do not replace the default-policy live suite.

The initial live suite ran before the final control hardening. Its traffic generator, statistical method and service behavior are unchanged. Twelve final control-specific reruns retained another **63,712 requests**, with a maximum confirmed withdrawal of **164.565 ms** and zero violations. All **84 source hashes** (seven files × 12 runs) matched the final backend: [source verification](evidence/final-control-runs/source-verification.json). The hardening adds router stopped-run fencing, both delayed-advance race barriers, generation-conflict reconciliation, authenticated shutdown, malformed lease rejection and draining of pending heartbeat work. The final Windows test run passed all 28 tests. One earlier run failed 27/28 because a pending heartbeat wrote to a closed database during simulated restart; the lifecycle now explicitly drains that work. The real controller-kill tests remain separate.

The frozen simulation suite produced **0/200 false regression flags**, **100/100 large-regression detections**, and **0/100 false advancement**. Healthy simulations completed in 135/200 cases and stayed inconclusive in 65/200. All 60 near-boundary cases stayed inconclusive. Forty correlated-workload cases are reported separately. The complete 1,436 checkpoint judgments were reproduced from compact raw inputs. [Method and independent numerical references](STATISTICS.md), [frozen manifest, confidence intervals, raw results and initial failed evaluation](../evaluation/README.md) document these finite synthetic claims. Numerical verification compares 108 intervals with SciPy reference calculations.

## Interface and recording

The browser workflow checks a real healthy run through all three explicit stages, reload/history, export, missing telemetry, manual stop, keyboard navigation and policy disclosure. Four states were checked at **360, 768 and 1440 px** with no horizontal page overflow or automated WCAG-tagged findings: [browser report](browser-verification.json). Microsoft Edge 157.0.4341.60, Playwright 1.65.0 and axe-core 4.14.0 were used on Windows.

[Additional interface boundary checks](ui-boundary-verification.json) exercise custom frozen policies and invalid drafts through the real API, then explicitly intercept state responses to test disconnected, historical and unconfirmed-control displays. Those intercepted views are UI boundary tests, not live control evidence. Live rates and p95 are labeled descriptive and never authorize extra statistical checkpoints. Automated checks do not constitute accessibility certification or a human usability study.

The [captioned walkthrough](walkthrough.webm) is an **85.68-second** recording of actual local requests and decisions, including the recorder tail. [Capture metadata](walkthrough-capture.json), [captions](walkthrough.vtt), screenshots and [reproduction instructions](WALKTHROUGH.md) are retained. It was captured before the final display/recovery refinements; its healthy/stop/missing-telemetry workflow remains the same. Caption overlays do not replace application results.

## Reproduction and environment

Windows runtime: Node **24.14.0**, npm **11.9.0**, Windows 11, Intel Core Ultra 9 285K, approximately 32 GB RAM. The host also ran browser/model-development work; measurements were not isolated. Each exported run records exact environment, policy, source/configuration fingerprints, seed, observed requests and decisions. Dependencies are pinned in `package-lock.json`.

```sh
npm ci
npm run build
npm test
npm run verify:runtime
npm start
# Separate terminal:
npm run verify:browser
npm run verify:ui-boundaries
npm run reanalyze -- docs/evidence/live-runs/healthy-101.json.gz
npm run verify:recording
```

A local Ubuntu/WSL attempt verified the official Node 24.14.0 download checksum and installed locked dependencies, but the guest then stopped responding before test/build output. This is recorded in [the Linux attempt](linux-verification.json); it is not counted as a Linux pass. The repository's Windows/Ubuntu CI matrix runs installation, strict build and all behavior tests from clean Git checkouts. Its delivery outcome is recorded after the initial push.

## Remaining limits

The application routes only to its bundled loopback services. Synthetic, matched traffic shares host resources. Binomial assumptions and conservative healthy holds are explicit; correlated workloads do not inherit a universal bound. Completed-response p95 excludes censored durations. A confirmed stop changes new routing only. No customer-data evaluation, human usability study, production rollout, public executable backend, or full production promotion is claimed.
