import { useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { z } from 'zod';
import { policySchema } from '../src/domain.ts';
import './style.css';

const interval = z.object({ lower: z.number(), upper: z.number() });
const rate = z.object({ count: z.number(), total: z.number(), estimate: z.number().nullable(), interval });
const judgment = z.object({
  status: z.enum(['eligible to advance', 'regression detected', 'inconclusive']),
  checkpoint: z.number(), reasons: z.array(z.string()), method: z.string(), tailAlpha: z.number(),
  checks: z.array(z.object({ cohort: z.string(), outcome: z.enum(['error', 'slow']), baseline: rate, candidate: rate,
    degradation: interval, tolerance: z.number(), baselineLimit: z.number(), baselineHealthy: z.boolean(),
    status: z.enum(['within tolerance', 'regression', 'uncertain']) })),
  metrics: z.array(z.object({ arm: z.enum(['baseline', 'candidate']), cohort: z.string(), attempted: z.number(),
    completed: z.number(), failed: z.number(), timedOut: z.number(), missing: z.number(), error: rate, slow: rate,
    p95CompletedMs: z.number().nullable(), censored: z.number(), achievedRps: z.number().nullable(), maxConcurrency: z.number() })),
  integrity: z.array(z.object({ name: z.string(), passed: z.boolean(), detail: z.string() })),
});
const runSchema = z.object({
  id: z.string(), scenario: z.string(), seed: z.number(), createdAt: z.string(),
  state: z.enum(['prepared', 'running', 'held', 'stopping', 'rolled back', 'completed', 'interrupted']),
  stage: z.number(), generation: z.number(), observedGeneration: z.number(), policy: policySchema,
  decision: judgment.nullable(), stages: z.array(z.object({ stage: z.number(), decision: judgment.nullable() })),
  events: z.array(z.object({ at: z.string(), type: z.string(), message: z.string(), generation: z.number() })),
  rollback: z.object({ decisionAt: z.string(), acknowledgedAt: z.string(), confirmedAt: z.string(), elapsedMs: z.number(), observedVersion: z.string() }).nullable(),
  progress: z.object({ baseline: z.number(), candidate: z.number(), stable: z.number(), warmup: z.number(), total: z.number() }),
  liveMetrics: z.array(z.object({ arm: z.enum(['baseline', 'candidate']), attempted: z.number(), completed: z.number(),
    failed: z.number(), missing: z.number(), timedOut: z.number(), errorRate: z.number().nullable(), slowRate: z.number().nullable(),
    p95CompletedMs: z.number().nullable(), cohorts: z.record(z.string(), z.number()) })).default([]),
  error: z.string().nullable(),
});
const stateSchema = z.object({
  active: runSchema.nullable(), defaults: policySchema,
  scenarios: z.array(z.object({ id: z.string(), label: z.string(), description: z.string() })),
  history: z.array(z.object({ id: z.string(), scenario: z.string(), createdAt: z.string(), state: z.string(), stage: z.number(), status: z.string().nullable() })),
});
type Run = z.infer<typeof runSchema>;
type Snapshot = z.infer<typeof stateSchema>;
const percent = (n: number | null) => n === null ? '—' : `${(n * 100).toFixed(2)}%`;
const number = (n: number) => n.toLocaleString('en-US');
const time = (date: string) => new Date(date).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const exposure = [5, 25, 50];

async function request(path: string, body?: unknown): Promise<unknown> {
  const response = await fetch(path, { signal: AbortSignal.timeout(15000), ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
  const result: unknown = await response.json();
  if (!response.ok) {
    const error = z.object({ error: z.string() }).safeParse(result);
    throw new Error(error.success ? error.data.error : `Request failed (${response.status}).`);
  }
  return result;
}

function App() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [scenario, setScenario] = useState('healthy');
  const [seed, setSeed] = useState('20261117');
  const [policyText, setPolicyText] = useState<string | null>(null);
  const [selected, setSelected] = useState<Run | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [connectionError, setConnectionError] = useState('');
  const [connected, setConnected] = useState(true);
  const refresh = useCallback(async () => {
    const next = stateSchema.parse(await request('/api/state'));
    setSnapshot(next);
    setConnected(true);
    setConnectionError('');
    setPolicyText(previous => previous ?? JSON.stringify(next.defaults, null, 2));
  }, []);
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try { await refresh(); }
      catch (cause) { if (!cancelled) { setConnected(false); setConnectionError(cause instanceof Error ? cause.message : 'Cannot reach the local service.'); } }
      if (!cancelled) timer = setTimeout(poll, 1200);
    };
    void poll();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [refresh]);
  async function act(action: () => Promise<void>) {
    setBusy(true); setError('');
    try { await action(); await refresh(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'The action could not complete.'); }
    finally { setBusy(false); }
  }
  const run = selected ?? snapshot?.active ?? null;
  const live = snapshot?.active;
  const activeWork = live && ['prepared', 'running', 'held', 'stopping'].includes(live.state);
  const draftPolicy = (() => {
    try { return policySchema.safeParse(JSON.parse(policyText ?? '')); }
    catch { return null; }
  })();
  const policy = run?.policy ?? (draftPolicy?.success ? draftPolicy.data : snapshot?.defaults);
  const historical = selected !== null;
  const canAdvance = !historical && connected && run?.state === 'held' && run.decision?.status === 'eligible to advance';
  const canStop = !historical && run && ['prepared', 'running', 'held'].includes(run.state);
  const label = (id: string) => snapshot?.scenarios.find(item => item.id === id)?.label ?? id;
  async function start() {
    if (!seed.trim()) throw new Error('Enter a workload seed before starting.');
    const parsedSeed = z.coerce.number().int().min(0).max(4294967295).parse(seed);
    if (!draftPolicy?.success) throw new Error('The next-run policy is invalid. Fix its JSON and decision rules before starting.');
    const parsedPolicy = draftPolicy.data;
    await request('/api/runs', { scenario, seed: parsedSeed, policy: parsedPolicy });
    setSelected(null);
  }
  let title = 'A little traffic. A considered decision.';
  let description = 'Compare a fresh baseline and candidate under the same workload. Start with the healthy example, then see what changes when a release harms one cohort.';
  let tone = '';
  if (run) {
    if (run.state === 'running' || run.state === 'prepared') { title = 'Gathering the evidence.'; description = 'Real local HTTP requests are running. Decisions happen only at the frozen sample checkpoints. Advancement remains locked while evidence is incomplete.'; }
    else if (run.state === 'stopping') { title = 'Withdrawing candidate traffic.'; description = 'Waiting for the router acknowledgement and subsequent version-tagged requests. A stop request alone does not confirm rollback.'; tone = 'warning'; }
    else if (run.state === 'completed') { title = 'All three stages passed.'; description = 'The candidate met the frozen policy at the final 50% stage. This completes the local experiment; it does not promote a production release.'; }
    else if (run.decision?.status === 'regression detected') { title = 'This release should stop here.'; description = 'The evidence identifies a regression beyond the practical tolerance. Inspect the affected cohort and the observed withdrawal below.'; tone = 'bad'; }
    else if (run.state === 'rolled back' && run.rollback && run.decision?.status === 'eligible to advance') { title = 'Candidate traffic withdrawn.'; description = 'This run was stopped. Its statistical evidence is retained below, but advancing this stopped run is unavailable. Start a new run to evaluate another release.'; }
    else if (canAdvance || (historical && run.state === 'held' && run.decision?.status === 'eligible to advance')) { title = 'Evidence supports the next step.'; description = 'Every required cohort has enough evidence, the baseline is healthy, and the upper degradation bounds fit within policy. Advancing is your decision.'; }
    else { title = run.state === 'interrupted' ? 'Interrupted. Verify before continuing.' : 'There is not enough evidence to advance.'; description = run.error ?? run.decision?.reasons.join(' ') ?? 'This run was stopped by an operational policy or by its operator. An operational stop is separate from a statistical regression finding.'; tone = 'warning'; }
  }
  if (!connected) { title = 'Connection lost. Advancement is locked.'; description = 'The last received evidence is shown below. The router lease protects new traffic independently of this page. Reconnect to inspect the observed state.'; tone = 'bad'; }
  const candidate = run?.decision?.metrics.find(metric => metric.arm === 'candidate' && metric.cohort === 'overall');
  const baseline = run?.decision?.metrics.find(metric => metric.arm === 'baseline' && metric.cohort === 'overall');
  const liveCandidate = run?.liveMetrics.find(metric => metric.arm === 'candidate');
  const liveBaseline = run?.liveMetrics.find(metric => metric.arm === 'baseline');
  const liveMeasurements = !historical && run?.state === 'running';
  const metricLabel = !connected ? 'Last received measurements' : liveMeasurements ? 'Live · descriptive only' : run?.decision ? 'At decision checkpoint' : 'Captured · descriptive only';
  const errorRate = liveMeasurements ? liveCandidate?.errorRate ?? null : candidate?.error.estimate ?? liveCandidate?.errorRate ?? null;
  const baselineErrorRate = liveMeasurements ? liveBaseline?.errorRate ?? null : baseline?.error.estimate ?? liveBaseline?.errorRate ?? null;
  const slowRate = liveMeasurements ? liveCandidate?.slowRate ?? null : candidate?.slow.estimate ?? liveCandidate?.slowRate ?? null;
  const p95 = liveMeasurements ? liveCandidate?.p95CompletedMs ?? null : candidate?.p95CompletedMs ?? liveCandidate?.p95CompletedMs ?? null;
  const allocation = run && ['running', 'held'].includes(run.state) ? exposure[run.stage] ?? 0 : 0;
  const exposureUnconfirmed = !connected || !!(run && ['stopping', 'interrupted', 'prepared'].includes(run.state) && !run.rollback);
  const exposureLabel = exposureUnconfirmed ? 'Exposure unconfirmed · awaiting router evidence' : allocation ? 'Planned allocation' : 'Candidate exposure: 0%';

  return <>
    <a className="skip" href="#main">Skip to workbench</a>
    <header className="topbar"><div className="brand"><span className="brand-mark" aria-hidden="true">r</span>ReleaseGuard</div><div className="top-meta"><span className="mode">{historical ? 'Saved live run' : connected ? 'Local · live HTTP' : 'Disconnected'}</span><span>Release evidence / 01</span></div></header>
    <main id="main" tabIndex={-1} className="shell">
      <div className="intro"><div><p className="eyebrow">A release is a decision. Keep the evidence.</p><h1>Confidence, before exposure.</h1><p>A local canary workbench for the question that matters: is this change safe to advance?</p></div><div className="intro-note">Synthetic catalogue. Real requests.<br/>Every decision leaves a record.</div></div>
      {(error || connectionError) && <div className="notice" role="alert"><span>{error || connectionError}</span><button onClick={() => { setError(''); void act(refresh); }}>Refresh status</button></div>}
      {!snapshot ? <div className="panel loading" role="status">{connected ? 'Connecting to the local workbench…' : 'Start the local server with npm start, then retry.'}</div> : <div className="layout">
        <aside className="sidebar" aria-label="Experiment setup">
          <section className="panel"><div className="section-top"><h2>Set up a run</h2><span className="section-number">01</span></div>
            <label className="form-field">Scenario<select value={scenario} onChange={event => setScenario(event.target.value)} disabled={!!activeWork || busy}>{snapshot.scenarios.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
            <p className="scenario-description">{snapshot.scenarios.find(item => item.id === scenario)?.description}</p>
            <label className="form-field">Workload seed<input inputMode="numeric" type="number" min="0" max="4294967295" value={seed} onChange={event => setSeed(event.target.value)} disabled={!!activeWork || busy}/><small>The request mix repeats. Network timing may vary.</small></label>
            <button className="button primary full" disabled={!!activeWork || busy || !connected} onClick={() => void act(start)}>{activeWork ? 'Run in progress…' : 'Start canary'}<span aria-hidden="true">↗</span></button>
            <p className="policy-note">Starting creates fresh comparison services. Existing evidence stays in history.</p>
          </section>
          {policy && <section className="panel"><div className="section-top"><h2>{run ? 'Frozen policy' : 'Analysis policy'}</h2><span className="section-number">02</span></div>
            <div className="policy-summary"><div className="policy-row"><span>Error increase</span><strong>≤ {(policy.errorTolerance * 100).toFixed(1)} pp</strong></div><div className="policy-row"><span>Slow increase</span><strong>≤ {(policy.slowTolerance * 100).toFixed(1)} pp</strong></div><div className="policy-row"><span>Slow means</span><strong>&gt; {policy.slowMs} ms</strong></div><div className="policy-row"><span>Required cohorts</span><strong>{policy.cohorts.length}</strong></div><div className="policy-row"><span>Run error budget</span><strong>{percent(policy.alpha)}</strong></div></div>
            <details className="disclosure"><summary>Inspect the decision rules</summary><div><dl className="policy-dl"><dt>Samples / arm</dt><dd>{policy.checkpoints.map(number).join(' / ')}</dd><dt>Minimum / cohort</dt><dd>{number(policy.minimumPerCohort)}</dd><dt>Baseline error ceiling</dt><dd>{percent(policy.baselineErrorMax)}</dd><dt>Baseline slow ceiling</dt><dd>{percent(policy.baselineSlowMax)}</dd><dt>Stage time limit</dt><dd>{policy.stageTimeoutMs / 1000}s</dd><dt>Telemetry grace</dt><dd>{policy.telemetryGraceMs / 1000}s</dd><dt>Router lease</dt><dd>{policy.leaseMs / 1000}s</dd><dt>Cohorts</dt><dd>{policy.cohorts.join(', ')}</dd></dl><p className="micro">Conservative binomial bounds cover both outcomes, every cohort, both arms, all stages and planned checkpoints. Upper bounds must fit within tolerance. Overlapping uncertainty means hold.</p><p className="micro">pp = percentage points. p95 is context, not another statistical test.</p></div></details>
            <details className="disclosure policy-editor"><summary>Edit policy for the next run</summary><div><label className="form-field">Next-run policy · JSON<textarea spellCheck={false} value={policyText ?? ''} onChange={event => setPolicyText(event.target.value)} disabled={!!activeWork || busy}/></label><button className="button text" onClick={() => setPolicyText(JSON.stringify(snapshot.defaults, null, 2))} disabled={!!activeWork}>Restore defaults</button><p className="micro" role="status">{draftPolicy?.success ? 'Draft policy is valid. ' : 'Draft policy is invalid; starting a run is blocked. '}Edits apply only when you start a new run. This run’s policy remains frozen.</p></div></details>
          </section>}
          <section className="panel history-panel"><div className="section-top"><h2>Run history</h2><span className="tag">{snapshot.history.length}</span></div>{snapshot.history.length ? <ul className="history-list">{snapshot.history.map(item => <li key={item.id}><button className={`history-button ${run?.id === item.id ? 'selected' : ''}`} disabled={busy} onClick={() => void act(async () => { setSelected(item.id === snapshot.active?.id ? null : runSchema.parse(await request(`/api/runs/${item.id}`))); })}><span>{label(item.scenario)}<small>{time(item.createdAt)} · {item.state}</small></span><span className="history-dot" aria-hidden="true"/></button></li>)}</ul> : <p className="micro">Your first run will appear here. Reloading preserves its evidence.</p>}
            <button className="button text" disabled={busy || !connected} onClick={() => void act(async () => { await request('/api/reset', {}); setSelected(null); })}>Reset workbench</button><p className="micro">Stops local traffic. Saved run evidence is retained.</p>
          </section>
        </aside>
        <div className="workspace">
          {historical && run && <div className="history-note">Viewing a saved run from {new Date(run.createdAt).toLocaleString()}. <button className="button text" onClick={() => setSelected(null)}>Return to current run</button></div>}
          <section className={`panel status-card ${tone}`} aria-label="Run decision"><span className="status-icon" aria-hidden="true">{run?.decision?.status === 'regression detected' ? '×' : run?.decision?.status === 'eligible to advance' ? '✓' : '↗'}</span><p className="eyebrow">{run ? `${label(run.scenario)} / ${run.state}` : 'Ready when you are'}</p><h2 aria-live="polite">{title}</h2><p>{description}</p>{run && <div className="actions"><button className="button" disabled={!canAdvance || busy} onClick={() => void act(async () => { await request(`/api/runs/${run.id}/advance`, { generation: run.generation }); })}>Advance to {exposure[run.stage + 1] ?? 50}%</button>{canStop && <button className="button danger" disabled={busy || !connected} onClick={() => void act(async () => { await request(`/api/runs/${run.id}/stop`, {}); })}>Stop candidate traffic</button>}<a className="button" href={`/api/runs/${run.id}/export`} download>Export evidence ↓</a></div>}</section>
          <section className="panel stage-panel" aria-label="Rollout stages"><div className="section-top"><h2>Small steps, explicit decisions.</h2><span className="tag">{run ? `Stage ${run.stage + 1} of 3` : 'Three stages'}</span></div><div className="stage-track">{exposure.map((share, index) => <div key={share} className={`stage-step ${run?.stage === index ? 'current' : ''} ${run && (run.stage > index || run.state === 'completed') ? 'done' : ''}`}><div className="stage-name"><span className="step-index">{index + 1}</span>{index === 0 ? 'First signal' : index === 1 ? 'Build evidence' : 'Final check'}</div><strong>{share}% + {share}%</strong><small>baseline + candidate<br/>{100 - 2 * share}% stable traffic</small></div>)}</div><div className="exposure" aria-hidden="true"><div className="stable" style={{ width: `${exposureUnconfirmed ? 0 : 100 - allocation * 2}%` }}/><div className="baseline" style={{ width: `${exposureUnconfirmed ? 0 : allocation}%` }}/><div className="candidate" style={{ width: `${exposureUnconfirmed ? 0 : allocation}%` }}/></div><div className="legend"><span><i className="swatch"/>Stable</span><span><i className="swatch baseline"/>Fresh baseline</span><span><i className="swatch candidate"/>Candidate</span><span>{exposureLabel}</span></div></section>
          <div className="metrics">
            <section className="panel metric"><p className="metric-label">Compared requests</p><div className="metric-value">{run ? number(run.progress.baseline + run.progress.candidate) : '—'}</div><p className="metric-foot">{run ? `${number(run.progress.warmup)} warm-up · ${number(run.progress.stable)} stable · all stages` : 'Warm-up excluded from analysis'}</p></section>
            <section className="panel metric"><p className="metric-label">Candidate errors</p><div className="metric-value">{percent(errorRate)}</div><p className="metric-foot">{run ? `${percent(baselineErrorRate)} baseline · ${metricLabel}` : 'Available during measurement'}</p></section>
            <section className="panel metric"><p className="metric-label">Candidate p95</p><div className="metric-value">{p95 === null ? '—' : `${Math.round(p95)} ms`}</div><p className="metric-foot">Completed requests only · {run ? metricLabel : 'Descriptive context'}</p></section>
          </div>
          {!!run?.liveMetrics.length && <section className="panel evidence-panel" aria-label="Current stage request measurements"><div className="section-top"><h2>Current stage measurements</h2><span className="tag">{!connected ? 'Last received' : liveMeasurements ? 'Live · descriptive' : 'Captured · descriptive'}</span></div><p className="micro">Candidate slow requests: {percent(liveMeasurements ? slowRate : liveCandidate?.slowRate ?? null)}. Counts below include current-stage attempts; warm-up is excluded. Missing records are unknown, never zero. These measurements do not authorize advancement.</p><details className="disclosure"><summary>Inspect live counts and cohort mix</summary><div className="table-scroll" role="region" aria-label="Live request accounting" tabIndex={0}><table><thead><tr><th>Arm</th><th>Attempted</th><th>Completed</th><th>Failures / timeouts</th><th>Missing</th><th>Cohort attempts</th></tr></thead><tbody>{run.liveMetrics.map(metric => <tr key={metric.arm}><td>{metric.arm}</td><td>{number(metric.attempted)}</td><td>{number(metric.completed)}</td><td>{number(metric.failed)} / {number(metric.timedOut)}</td><td>{number(metric.missing)}</td><td>{Object.entries(metric.cohorts).map(([cohort, count]) => `${cohort}: ${number(count)}`).join(' · ')}</td></tr>)}</tbody></table></div></details></section>}
          <section className="panel evidence-panel"><div className="section-top"><h2>What does the evidence say?</h2><span className={`tag ${run?.decision?.status === 'regression detected' ? 'bad' : 'warn'}`}>{run?.decision?.status ?? 'Awaiting checkpoint'}</span></div>{run?.decision ? <><div className="table-scroll" role="region" aria-label="Cohort comparison evidence" tabIndex={0}><table><thead><tr><th scope="col">Cohort / outcome</th><th scope="col">Baseline</th><th scope="col">Candidate</th><th scope="col">Increase bounds</th><th scope="col">Finding</th></tr></thead><tbody>{run.decision.checks.map(check => <tr key={`${check.cohort}-${check.outcome}`}><td><strong>{check.cohort}</strong><small>{check.outcome === 'slow' ? `Slower than ${run.policy.slowMs} ms` : 'Failed requests'}</small></td><td>{percent(check.baseline.estimate)}<small>{number(check.baseline.count)} / {number(check.baseline.total)}</small></td><td>{percent(check.candidate.estimate)}<small>{number(check.candidate.count)} / {number(check.candidate.total)}</small></td><td>{(check.degradation.lower * 100).toFixed(2)} to {(check.degradation.upper * 100).toFixed(2)} pp<small>Tolerance +{(check.tolerance * 100).toFixed(1)} pp</small></td><td><span className={`tag ${check.status === 'regression' ? 'bad' : check.status === 'uncertain' ? 'warn' : ''}`}>{check.status}</span>{!check.baselineHealthy && <small>Baseline health not established</small>}</td></tr>)}</tbody></table></div><p className="caption">Complete cohort comparisons at {number(run.decision.checkpoint)} planned samples per arm. Counts include failures and timeouts. Missing records cannot pass.</p><details className="disclosure"><summary>Inspect sample integrity and uncertainty</summary><div><ul className="checks">{run.decision.integrity.map((check, index) => <li key={index}><strong>{check.passed ? 'Passed' : 'Blocked'} · {check.name}:</strong> {check.detail}</li>)}</ul><p className="micro">{run.decision.method}. Per-tail error budget: {run.decision.tailAlpha.toExponential(3)}.</p><div className="table-scroll" role="region" aria-label="Request accounting" tabIndex={0}><table><thead><tr><th>Arm / cohort</th><th>Attempted</th><th>Completed</th><th>Failures</th><th>Missing</th><th>Req/s</th><th>Peak concurrent</th></tr></thead><tbody>{run.decision.metrics.map(metric => <tr key={`${metric.arm}-${metric.cohort}`}><td>{metric.arm} / {metric.cohort}</td><td>{metric.attempted}</td><td>{metric.completed}</td><td>{metric.failed}<small>{metric.timedOut} timeout</small></td><td>{metric.missing}</td><td>{metric.achievedRps?.toFixed(1) ?? '—'}</td><td>{metric.maxConcurrency}</td></tr>)}</tbody></table></div></div></details><ul className="checks">{run.decision.reasons.map((reason, index) => <li key={index}>{reason}</li>)}</ul></> : <div className="empty-evidence"><div className="illustration" aria-hidden="true">{[36, 37, 66, 68, 47, 48, 83, 85].map((height, index) => <span key={index} style={{ height }}/>)}</div><div><h3>Look beyond the average.</h3><p>Errors and slow requests are compared overall and within every required cohort. A healthy average cannot hide a missing or harmed cohort.</p><p className="caption">Illustration only. Live measurements appear after the first planned checkpoint.</p></div></div>}{run?.rollback && <div className="rollback"><strong>Withdrawal observed · {Math.round(run.rollback.elapsedMs)} ms</strong><br/>Router acknowledged at {time(run.rollback.acknowledgedAt)}. Subsequent request returned <span className="mono">{run.rollback.observedVersion}</span> at {time(run.rollback.confirmedAt)}.<br/>New traffic is withdrawn; requests already in flight may finish or time out.</div>}</section>
          <section className="panel evidence-panel"><div className="section-top"><h2>The decision trail</h2><span className="snapshot-time">{run ? `Planned ${run.generation} / observed ${run.observedGeneration}` : 'Persisted with every run'}</span></div>{run?.events.length ? <ol className="event-list">{run.events.slice(-8).reverse().map((event, index) => <li key={`${event.at}-${index}`}><span className="event-node" aria-hidden="true"/><div><p>{event.message}</p><time dateTime={event.at}>{time(event.at)} · {event.type} · generation {event.generation}</time></div></li>)}</ol> : <p className="micro">Traffic checkpoints, decisions, router acknowledgements, and recovery observations will appear here. Export keeps the full record.</p>}</section>
        </div>
      </div>}
      <footer className="footer"><span>ReleaseGuard · A local experiment with synthetic traffic.<br/>No external target, production promotion, or model credential required.</span><span>Conservative decisions under declared independence assumptions.<br/>Shared-host load and correlated requests remain limitations.</span></footer>
    </main>
  </>;
}
const root = document.getElementById('root');
if (!root) throw new Error('Application root missing');
createRoot(root).render(<App/>);
