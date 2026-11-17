# Architecture and decisions

The service engineer's workflow is configure, inspect policy, measure, inspect evidence, explicitly advance or stop, then export. HTTP timing and routing come from actual processes. There is no simulated success response in the interface.

`src/runtime.ts` owns run lifecycle and a seeded traffic generator. `src/router.ts` owns observed routing generations independently of the controller; lease expiry withdraws candidate traffic even when the controller disappears. `src/service.ts` is a read-only fictional catalogue. `src/store.ts` saves SQLite snapshots of each immutable-policy run and its append-only evidence/event history. `src/analysis.ts` does no I/O and is shared by runtime judgment, independent recorded-input reanalysis, and evaluation.

The controller persists planned control state before dispatch. The router accepts generation-matched commands. A new stage requires the current eligible result and its generation, preventing delayed or repeated advance requests from reviving a stopped run. Startup reconciles the surviving router, requests withdrawal if necessary, then observes baseline version IDs. Unresolved control state blocks advancement. A dead router cannot be recorded as a confirmed withdrawal.

Each stage freezes its policy and records the exact observation prefix and analysis context used for judgment. Later in-flight completions and diagnostic probes remain in the export but do not silently change prior decisions. JSON reanalysis reproduces the judgment; a new live run is not expected to reproduce network timing.

The generator supplies matched comparison counts and cohort/draw pairs, shuffles each batch, and fills remaining allocation with stable requests. Both comparison arms share the same bounded concurrency pool and fresh-process warm-up. Captured achieved rates/concurrency make host contention visible. This is a local matched-load experiment, not independent production traffic or resource isolation by container quotas.

Clopper–Pearson intervals are conservative but interpretable and independently checkable. Correcting over all frozen opportunities avoids treating each chart refresh as a new test. A healthy candidate may remain inconclusive when the baseline's health or small cohort rates cannot be established precisely enough. p95 remains descriptive; no additional significance claim is attached to it.

The API validates inputs, rejects foreign origins/hosts, caps request bodies, and never accepts an arbitrary destination URL. The router forwards only to the three bundled loopback ports. Local same-user processes are outside the threat boundary; this is not an internet-facing service. No model or credential is used.
