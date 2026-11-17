# Statistical decisions

ReleaseGuard compares **failed requests** and **requests taking more than 300 ms**. The default practical tolerances are increases of 1 percentage point and 2 percentage points. P95 over completed HTTP responses is descriptive; it does not add a significance test. A timeout is a failure; its observed deadline duration also counts as slow if it exceeds the threshold. Timed-out or transport-failed requests have censored completion times and do not enter completed-response p95.

The analysis is a pure function of the frozen policy, a prefix of recorded observations and recorded integrity context. It never reads a clock, contacts a service or changes a router. A live run's exact input prefix and context are recorded with each stage decision. `npm run reanalyze -- export.json` compares the entire resulting judgment with the recorded one, including counts, intervals and reasons. This reproduces a recorded judgment, not the timing of a new HTTP run.

## Interval calculation and budget

For `k` events among `n` known outcomes, the implementation uses Clopper–Pearson binomial bounds obtained by inverting the beta distribution. Zero and all-event cases use their closed forms. The numerical implementation uses a continued fraction and bounded bisection, and throws if the continued fraction fails to converge. It is checked against 108 independently generated SciPy intervals, including extreme counts, 20,000 observations and the smallest supported tail allocation; absolute differences must be less than `1e-9`.

Primary references: [R's exact binomial test documentation](https://stat.ethz.ch/R-manual/R-devel/library/stats/html/binom.test.html) explains the conservative Clopper–Pearson coverage; [SciPy's exact proportion interval API](https://docs.scipy.org/doc/scipy/reference/generated/scipy.stats._result_classes.BinomTestResult.proportion_ci.html) supplies the independent numerical reference. No third-party numerical implementation was copied into the application.

The default run-wide interval error budget is 0.05. Each individual tail receives:

```text
0.05 / (3 stages × 2 checkpoints × 3 groups × 2 outcomes × 2 arms × 2 tails)
= 0.00034722222222222224
```

The three groups are overall, desktop and mobile. Both checkpoints (1,600 and 3,200 attempts per arm), all three stages and every comparison are declared before running. A union bound controls the chance of any failed interval coverage under the stated binomial assumptions. It does not require independence between arms, outcomes or checkpoints. It **does** rely on the observations within an arm/cohort representing independent Bernoulli trials with a stable probability. Correlated service failures violate that assumption and receive separate stress reporting.

The fixed cohort mix is a stratified sample. Overall intervals are weighted sums of simultaneous cohort intervals using each arm's observed cohort proportions; the engine does not assume heterogeneous aggregate trials are identically distributed. The budget still reserves an overall slot, which is conservative. Unknown cohorts and materially different arm mixes invalidate the comparison. There is no claim to implement Netflix's sequential method.

Candidate degradation is bounded by `[candidate.lower − baseline.upper, candidate.upper − baseline.lower]`. An upper bound at or below tolerance supports advancement. A lower bound strictly above tolerance establishes a regression. Anything between them is inconclusive. Live progress does not authorize extra decision checkpoints.

## Advancement and operational stops

Advancement requires all outcome/cohort comparisons to be within tolerance, at least 800 known observations per required cohort per arm, complete/fresh telemetry, unique attempt IDs, comparable workload and reconciled control state. The baseline's upper error bound must be at most 1% and its upper slow bound at most 5% in every cohort. Thus a shared unhealthy baseline cannot authorize advancement. Baseline uncertainty does not conceal an independently established candidate regression; it only prevents advancement.

The exact checkpoint attempt count is enforced. Underpowered and incomplete stages stay inconclusive. An emergency exposure stop, telemetry grace expiry or control lease expiry is an operational action, not a claim of statistical confidence. Missing observations never become zero-valued measurements. The attempt reconciliation is `attempted = completed HTTP responses + censored transport/timeout attempts + missing`; failed HTTP responses are both completed and failed, rather than a disjoint additional bucket.

The first-checkpoint feasibility calculation is analytic: with zero events among 800 cohort requests, the simultaneous upper bound is 0.009907525833125848, below the 1% error tolerance. This shows that a healthy, balanced zero-error fixture can pass at every stage. It does not guarantee that all noisy healthy services fit this sample budget. The frozen simulation suite quantifies the resulting inconclusive rate.

## Frozen evaluation and limits

See [evaluation results](../evaluation/README.md) for all denominators, intervals, initial failures and the separate correlated workload report. The simulation data is synthetic. The method offers no universal operational safety guarantee and does not establish a production SLO. New policy values create a new run; the reported results apply to the frozen fixture policy only.
