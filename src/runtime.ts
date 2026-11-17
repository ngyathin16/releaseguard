import { fork, type ChildProcess } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { analyze } from './analysis.ts';
import { DEFAULT_POLICY, type Policy, type RequestObservation, type Judgment, type Stage, type AnalysisContext } from './domain.ts';
import { Store } from './store.ts';

export const scenarios = [
  { id: 'healthy', label: 'Healthy candidate', description: 'Matching versions under balanced synthetic traffic.' },
  { id: 'broad-latency', label: 'Broad latency regression', description: 'Every candidate response waits 360 ms.' },
  { id: 'tail-latency', label: 'Tail latency regression', description: 'Twelve percent of candidate requests wait 360 ms.' },
  { id: 'cohort-regression', label: 'Mobile cohort regression', description: 'One quarter of mobile candidate requests wait 360 ms.' },
  { id: 'configuration-errors', label: 'Configuration errors', description: 'Candidate configuration rejects fifteen percent of requests.' },
  { id: 'insufficient-traffic', label: 'Insufficient traffic', description: 'Traffic ends before the required cohort sample counts.' },
  { id: 'missing-metrics', label: 'Lost telemetry', description: 'Candidate responses arrive but their measurement records are lost.' },
  { id: 'unbalanced-workload', label: 'Unbalanced cohorts', description: 'Candidate receives a different cohort mix.' },
  { id: 'unhealthy-baseline', label: 'Shared dependency failure', description: 'Both comparison arms fail twenty percent of requests.' },
  { id: 'candidate-crash', label: 'Candidate crash', description: 'Candidate process is killed during measurement.' },
  { id: 'lease-expiry', label: 'Expired control lease', description: 'Controller deliberately stops renewing the router lease.' },
] as const;

type Event = { at: string; monotonicMs: number; type: string; message: string; generation: number };
export type Run = {
  id: string; scenario: string; seed: number; createdAt: string;
  state: 'prepared' | 'running' | 'held' | 'stopping' | 'rolled back' | 'completed' | 'interrupted';
  stage: Stage; generation: number; plannedGeneration: number; observedGeneration: number; policy: Policy; decision: Judgment | null;
  decisionInput: { observationCount: number; context: AnalysisContext } | null;
  judgments: { at: string; decision: Judgment; input: { observationCount: number; context: AnalysisContext } }[];
  stages: { stage: number; startedAt: string; finishedAt?: string; decision: Judgment | null; decisionInput?: { observationCount: number; context: AnalysisContext } }[];
  observations: RequestObservation[]; events: Event[];
  rollback: { decisionAt: string; acknowledgedAt: string; confirmedAt: string; elapsedMs: number; observedVersion: string } | null;
  environment: { node: string; platform: string; cpu: string; memoryBytes: number; fingerprints: Record<string, string>; concurrency: number; warmupPerArm: number; requestTimeoutMs: number; emergencyFailureRate: number; emergencyMinimumSamples: number; matchedLoad: string };
  progress: { baseline: number; candidate: number; stable: number; warmup: number; total: number };
  error: string | null;
};
const processReady = z.object({ port: z.number().int().min(1).max(65535), pid: z.number().int(), version: z.string().optional(), fingerprint: z.string().optional(), instance: z.string().optional() });
const routerStateSchema = z.object({ generation: z.number().int(), stage: z.number().int(), enabled: z.boolean(), runId: z.string(), instance: z.string(), leaseRemainingMs: z.number().optional() });
type RouterState = z.infer<typeof routerStateSchema>;
type Stack = { port: number; token: string; instance: string; pids: number[]; servicePorts: number[]; fingerprints: Record<string, string> };
const directory = path.dirname(fileURLToPath(import.meta.url));
const loadedFingerprints = Object.fromEntries(['runtime.ts', 'analysis.ts', 'domain.ts', 'store.ts', 'server.ts'].map(file => [file, createHash('sha256').update(readFileSync(path.join(directory, file))).digest('hex')]));
const agent = new http.Agent({ keepAlive: true, maxSockets: 64 });
function rng(seed: number) { let value = seed >>> 0; return () => { value += 0x6D2B79F5; let t = Math.imul(value ^ value >>> 15, 1 | value); t ^= t + Math.imul(t ^ t >>> 7, 61 | t); return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
export class Runtime {
  store: Store;
  active: Run | null = null;
  stack: Stack | null = null;
  children: ChildProcess[] = [];
  busy = false;
  stopPromise: Promise<void> | null = null;
  timer: ReturnType<typeof setInterval> | null = null;
  heartbeatPending: Promise<void> | null = null;
  task: Promise<void> | null = null;
  constructor(database: string) { this.store = new Store(database); }
  async init() {
    this.stack = this.store.metadata('stack');
    const summaries = this.store.history();
    const priorSummary = summaries.find((run: { state: string }) => ['prepared', 'running', 'held', 'stopping'].includes(run.state));
    const prior: Run | undefined = priorSummary ? this.store.get(priorSummary.id) : undefined;
    if (prior) {
      this.active = prior;
      this.event(prior, 'recovery', 'Controller restarted; reconcile the observed router before any advancement.');
      try { await this.stop('Controller restart interrupted this run.', 'interrupted'); }
      catch (error) { prior.state = 'interrupted'; prior.error = `Control recovery unresolved: ${String(error)}`; this.save(prior); }
    } else this.active = summaries[0] ? this.store.get(summaries[0].id) : null;
    this.timer = setInterval(() => {
      this.heartbeatPending ??= this.heartbeat().finally(() => { this.heartbeatPending = null; });
    }, 100);
  }
  event(run: Run, type: string, message: string) { run.events.push({ at: new Date().toISOString(), monotonicMs: performance.now(), type, message, generation: run.generation }); }
  save(run: Run) { this.store.save(run.id, run); }
  publicRun(run: Run) {
    const { observations, ...publicFields } = run;
    const liveMetrics = (['baseline', 'candidate'] satisfies ('baseline' | 'candidate')[]).map(arm => {
      const rows = observations.filter(row => row.arm === arm && row.stage === run.stage && !row.warmup && !row.diagnostic);
      const known = rows.filter(row => !row.missing);
      const durations = known.flatMap(row => row.status !== null && !row.timeout && row.durationMs !== null ? [row.durationMs] : []).sort((a, b) => a - b);
      const failed = known.filter(row => row.failed || row.timeout).length;
      return { arm, attempted: rows.length, completed: durations.length, failed, missing: rows.length - known.length, timedOut: known.filter(row => row.timeout).length,
        errorRate: known.length ? failed / known.length : null, slowRate: known.length ? known.filter(row => row.durationMs !== null && row.durationMs > run.policy.slowMs).length / known.length : null,
        p95CompletedMs: durations.length ? durations[Math.ceil(durations.length * 0.95) - 1] ?? null : null,
        cohorts: Object.fromEntries(run.policy.cohorts.map(cohort => [cohort, rows.filter(row => row.cohort === cohort).length])) };
    });
    return { ...publicFields, observationCount: observations.length, liveMetrics };
  }
  state() { return { active: this.active ? this.publicRun(this.active) : null, history: this.store.history(), scenarios, defaults: DEFAULT_POLICY }; }
  async spawn(file: string, env: Record<string, string>) {
    const child = fork(path.join(directory, file), [], { detached: true, execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: { ...process.env, ...env } });
    this.children.push(child);
    return await new Promise<z.infer<typeof processReady>>((resolve, reject) => {
      const timeout = setTimeout(() => { child.kill(); reject(new Error(`${file} did not start`)); }, 10000);
      child.once('error', error => { clearTimeout(timeout); reject(error); });
      child.once('exit', code => { clearTimeout(timeout); reject(new Error(`${file} exited ${code}`)); });
      child.once('message', message => { clearTimeout(timeout); const parsed = processReady.safeParse(message); if (!parsed.success) { child.kill(); reject(new Error('Invalid child startup record')); return; } child.disconnect(); child.unref(); resolve(parsed.data); });
    });
  }
  async disposeStack() {
    const old = this.stack; this.stack = null;
    if (old) {
      // Authenticate shutdown to each process; a stored PID may have been reused after a crash.
      for (const port of [...(old.servicePorts ?? []), old.port]) {
        await fetch(`http://127.0.0.1:${port}/shutdown`, { method: 'POST', headers: { authorization: old.token }, signal: AbortSignal.timeout(1000) }).catch(() => null);
      }
    }
    this.store.setMetadata('stack', null);
  }
  async newStack(scenario: string) {
    await this.disposeStack();
    const token = randomUUID();
    const stable = await this.spawn('service.ts', { RG_ARM: 'stable', RG_SCENARIO: 'healthy', RG_TOKEN: token });
    const baseline = await this.spawn('service.ts', { RG_ARM: 'baseline', RG_SCENARIO: scenario, RG_TOKEN: token });
    const candidate = await this.spawn('service.ts', { RG_ARM: 'candidate', RG_SCENARIO: scenario === 'candidate-crash' ? 'healthy' : scenario, RG_TOKEN: token });
    const router = await this.spawn('router.ts', { RG_STABLE: String(stable.port), RG_BASELINE: String(baseline.port), RG_CANDIDATE: String(candidate.port), RG_TOKEN: token });
    if (!router.instance) throw new Error('Router did not identify its instance');
    const fingerprints: Record<string, string> = { ...loadedFingerprints, stable: stable.fingerprint ?? '', baseline: baseline.fingerprint ?? '', candidate: candidate.fingerprint ?? '' };
    for (const file of ['service.ts', 'router.ts']) fingerprints[file] = createHash('sha256').update(readFileSync(path.join(directory, file))).digest('hex');
    this.stack = { port: router.port, token, instance: router.instance, pids: [stable.pid, baseline.pid, candidate.pid, router.pid], servicePorts: [stable.port, baseline.port, candidate.port], fingerprints };
    this.store.setMetadata('stack', this.stack);
  }
  async observed() {
    if (!this.stack) throw new Error('No live router; recovery remains unresolved');
    const response = await fetch(`http://127.0.0.1:${this.stack.port}/state`, { headers: { authorization: this.stack.token }, signal: AbortSignal.timeout(1500) });
    const state = routerStateSchema.parse(await response.json());
    if (state.instance !== this.stack.instance) throw new Error('Router instance mismatch');
    return state;
  }
  async command(action: 'start' | 'stop' | 'renew', expectedGeneration: number, run: Run) {
    if (!this.stack) throw new Error('Router unavailable');
    if (action !== 'renew') { run.plannedGeneration = expectedGeneration + 1; this.save(run); }
    const response = await fetch(`http://127.0.0.1:${this.stack.port}/control`, { method: 'POST', headers: { authorization: this.stack.token, 'content-type': 'application/json' }, body: JSON.stringify({ action, expectedGeneration, runId: run.id, stage: run.stage, leaseMs: run.policy.leaseMs }), signal: AbortSignal.timeout(1500) });
    if (!response.ok) throw new Error(`Router rejected ${action}: ${response.status}`);
    const observed = routerStateSchema.parse(await response.json());
    if (observed.generation >= run.generation) { run.observedGeneration = observed.generation; run.generation = observed.generation; }
    return observed;
  }
  async create(scenario: string, seed: number, policy: Policy) {
    if (this.busy || (this.active && ['prepared', 'running', 'held', 'stopping'].includes(this.active.state))) throw new Error('Finish or stop the current run first.');
    this.busy = true;
    try {
      await this.task;
      await this.newStack(scenario);
      const run: Run = { id: randomUUID(), scenario, seed, createdAt: new Date().toISOString(), state: 'prepared', stage: 0, generation: 0, plannedGeneration: 0, observedGeneration: 0, policy: structuredClone(policy), decision: null, decisionInput: null, judgments: [], stages: [], observations: [], events: [], rollback: null, environment: { node: process.version, platform: `${process.platform} ${os.release()}`, cpu: os.cpus()[0]?.model ?? 'unknown', memoryBytes: os.totalmem(), fingerprints: this.stack?.fingerprints ?? {}, concurrency: 64, warmupPerArm: 20, requestTimeoutMs: 1000, emergencyFailureRate: 0.5, emergencyMinimumSamples: 20, matchedLoad: 'Equal counts per batch, identical cohort and random draw per arm, shuffled arrival order, shared 64-request concurrency cap; stable requests fill the staged allocation.' }, progress: { baseline: 0, candidate: 0, stable: 0, warmup: 0, total: 0 }, error: null };
      this.active = run; this.event(run, 'prepared', 'Policy frozen. Fresh baseline and candidate processes use identical process limits.'); this.save(run);
      await this.begin(run); return this.publicRun(run);
    } finally { this.busy = false; }
  }
  async begin(run: Run) {
    const state = await this.observed();
    if (run.state !== 'prepared') throw new Error('Start was superseded by a stop command.');
    this.event(run, 'planned', `Request stage ${run.stage + 1} at router generation ${state.generation + 1}.`); this.save(run);
    const acknowledgement = await this.command('start', state.generation, run);
    if (run.state !== 'prepared' || run.generation !== acknowledgement.generation) throw new Error('Start was superseded by a stop command.');
    run.state = 'running'; run.decision = null; run.decisionInput = null; run.stages.push({ stage: run.stage, startedAt: new Date().toISOString(), decision: null });
    this.event(run, 'acknowledged', `Router acknowledged equal ${[5, 25, 50][run.stage]}% comparison allocations.`); this.save(run);
    this.task = this.measure(run).catch(async error => { run.error = String(error); this.save(run); try { await this.stop('Measurement failed; evidence is incomplete.'); } catch { run.state = 'interrupted'; this.save(run); } });
  }
  async advance(id: string, generation: number) {
    const run = this.active;
    if (!run || run.id !== id || run.generation !== generation || run.state !== 'held' || run.decision?.status !== 'eligible to advance' || run.stage >= 2) throw new Error('Advance requires the current eligible stage and router generation.');
    run.state = 'prepared'; this.save(run);
    const observed = await this.observed();
    if (run.state !== 'prepared') throw new Error('Advance was superseded by a stop command.');
    if (!observed.enabled || observed.generation !== generation || observed.runId !== id) { run.state = 'interrupted'; this.save(run); throw new Error('Router state changed; advancement is blocked.'); }
    run.stage = run.stage === 0 ? 1 : 2; await this.begin(run); return this.publicRun(run);
  }
  async heartbeat() {
    const run = this.active;
    if (!run || !['running', 'held'].includes(run.state) || this.stopPromise) return;
    try {
      const state = await this.observed();
      if (!state.enabled || state.generation !== run.generation) { await this.stop('Router lease expired or control state changed.'); return; }
      if (run.scenario !== 'lease-expiry') await this.command('renew', state.generation, run);
    } catch (error) { if (run.state !== 'stopping') { run.error = String(error); await this.stop('Control connection failed; advancement is blocked.').catch(() => { run.state = 'interrupted'; this.save(run); }); } }
  }
  async request(run: Run, slot: number, cohort: string, draw: number, warmup: boolean): Promise<RequestObservation> {
    const stack = this.stack;
    if (!stack) throw new Error('No router for request');
    const startedMonoMs = performance.now();
    const allocation = [0.05, 0.25, 0.5][run.stage] ?? 0.05;
    const observation: RequestObservation = { id: randomUUID(), stage: run.stage, arm: slot < allocation ? 'baseline' : slot < allocation * 2 ? 'candidate' : 'stable', cohort, route: '/catalogue', startedAt: new Date().toISOString(), startedMonoMs, durationMs: null, status: null, version: null, failed: false, timeout: false, missing: false, warmup, generation: run.generation };
    return await new Promise(resolve => {
      let done = false;
      const finish = () => { if (done) return; done = true; observation.durationMs = performance.now() - startedMonoMs; resolve(observation); };
      const request = http.get({ hostname: '127.0.0.1', port: stack.port, path: `/catalogue?slot=${slot}&cohort=${encodeURIComponent(cohort)}&draw=${draw}`, headers: { authorization: stack.token }, agent }, response => {
        const arm = response.headers['x-release-arm']; if (arm === 'baseline' || arm === 'candidate' || arm === 'stable') observation.arm = arm;
        observation.generation = Number(response.headers['x-router-generation'] ?? run.generation);
        const version = response.headers['x-release-version']; observation.version = typeof version === 'string' ? version : null;
        observation.status = response.statusCode ?? 502; observation.failed = observation.status >= 400;
        response.resume(); response.once('end', finish); response.once('error', () => { observation.failed = true; finish(); });
      });
      // A total deadline also covers time waiting for a connection.
      const deadline = setTimeout(() => { observation.timeout = true; observation.failed = true; request.destroy(); finish(); }, run.environment.requestTimeoutMs);
      request.once('error', () => { observation.failed = true; finish(); }); request.once('close', () => clearTimeout(deadline));
    });
  }
  async batch(run: Run, random: () => number, warmup: boolean, pairs: number) {
    const allocation = [0.05, 0.25, 0.5][run.stage] ?? 0.05;
    const requests: { slot: number; cohort: string; draw: number }[] = [];
    for (let pair = 0; pair < pairs; pair++) {
      const cohort = run.policy.cohorts[pair % run.policy.cohorts.length] ?? 'desktop'; const draw = random();
      requests.push({ slot: allocation * 0.5, cohort, draw });
      requests.push({ slot: allocation * 1.5, cohort: run.scenario === 'unbalanced-workload' && pair % 10 ? 'mobile' : cohort, draw });
      for (let stable = 0; stable < Math.round(1 / allocation) - 2; stable++) requests.push({ slot: allocation * 2 + random() * (1 - allocation * 2), cohort, draw: random() });
    }
    for (let i = requests.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); const left = requests[i], right = requests[j]; if (left && right) { requests[i] = right; requests[j] = left; } }
    let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(64, requests.length) }, async () => {
      while (run.state === 'running') {
        const request = requests[cursor++]; if (!request) return;
        const observation = await this.request(run, request.slot, request.cohort, request.draw, warmup);
        if (run.scenario === 'missing-metrics' && !warmup && observation.arm === 'candidate') { observation.missing = true; observation.durationMs = null; observation.status = null; observation.version = null; observation.failed = false; }
        run.observations.push(observation); run.progress.total++;
        if (warmup) run.progress.warmup++; else run.progress[observation.arm]++;
      }
    }));
    this.save(run);
  }
  judgment(run: Run, checkpoint: number, fresh = true) {
    const context = { stage: run.stage, checkpoint, controlResolved: run.generation === run.observedGeneration, workloadComparable: run.scenario !== 'unbalanced-workload', telemetryFresh: fresh };
    run.decisionInput = { observationCount: run.observations.length, context };
    const decision = analyze(run.policy, run.observations, context);
    run.judgments ??= [];
    run.judgments.push({ at: new Date().toISOString(), decision, input: run.decisionInput });
    const stage = run.stages.at(-1); if (stage) { stage.decision = decision; stage.decisionInput = run.decisionInput; }
    return decision;
  }
  async measure(run: Run) {
    const random = rng(run.seed + run.stage * 1009);
    await this.batch(run, random, true, 20);
    if (run.state !== 'running') return;
    if (run.scenario === 'candidate-crash' && this.stack?.pids[2]) {
      const candidate = this.children.find(child => child.pid === this.stack?.pids[2] && child.exitCode === null);
      if (!candidate?.kill('SIGKILL')) throw new Error('Candidate crash injection could not find the owned process.');
      this.event(run, 'fault', 'Candidate process killed after warm-up.');
    }
    const start = performance.now();
    let checkpointIndex = 0;
    while (run.state === 'running') {
      const measured = run.observations.filter(row => !row.warmup && row.stage === run.stage);
      const candidate = measured.filter(row => row.arm === 'candidate');
      const baseline = measured.filter(row => row.arm === 'baseline');
      const planned = run.policy.checkpoints[checkpointIndex];
      if (measured.some(row => row.missing)) {
        this.event(run, 'telemetry', 'Missing measurements block advancement; the frozen grace period has started.'); this.save(run);
        await delay(run.policy.telemetryGraceMs);
        if (run.state !== 'running') return;
        run.decision = this.judgment(run, planned ?? 0, false); await this.stop('Telemetry remained missing after the grace period.'); return;
      }
      if (candidate.length >= run.environment.emergencyMinimumSamples && candidate.filter(row => row.failed).length / candidate.length > run.environment.emergencyFailureRate) { run.decision = this.judgment(run, planned ?? 0); await this.stop('Operational emergency: candidate failure rate exceeds 50% after 20 samples.'); return; }
      if (planned !== undefined && Math.min(candidate.length, baseline.length) >= planned) {
        run.decision = this.judgment(run, planned);
        const stage = run.stages.at(-1); if (stage) stage.decision = run.decision;
        this.event(run, 'decision', `${run.decision.status} at frozen checkpoint ${planned} per comparison arm.`); this.save(run);
        if (run.decision.status === 'regression detected') { await this.stop('Statistical regression detected.'); return; }
        if (run.decision.status === 'eligible to advance') {
          if (stage) stage.finishedAt = new Date().toISOString();
          if (run.stage === 2) await this.stop('Final 50% stage passed; demonstration complete.', 'completed');
          else { run.state = 'held'; this.event(run, 'held', 'Eligible; explicit advancement is required.'); this.save(run); }
          return;
        }
        checkpointIndex++;
        if (checkpointIndex >= run.policy.checkpoints.length) { await this.stop('All planned checkpoints were inconclusive.'); return; }
      }
      if (performance.now() - start >= run.policy.stageTimeoutMs) { run.decision = this.judgment(run, planned ?? 0); await this.stop('Stage time limit reached without sufficient passing evidence.'); return; }
      if (run.scenario === 'insufficient-traffic' && candidate.length >= 20) await delay(100);
      else await this.batch(run, random, false, Math.min(20, Math.max(1, (planned ?? 20) - Math.min(candidate.length, baseline.length))));
    }
  }
  async stop(reason = 'Stopped by the reviewer.', terminal: 'rolled back' | 'interrupted' | 'completed' = 'rolled back') {
    if (this.stopPromise) return this.stopPromise;
    const run = this.active;
    if (!run || (['rolled back', 'completed', 'interrupted'].includes(run.state) && run.rollback)) return;
    this.stopPromise = (async () => {
      const monotonic = performance.now(); const decisionAt = new Date().toISOString();
      run.state = 'stopping'; run.decision ??= this.judgment(run, run.policy.checkpoints[0] ?? 0); this.event(run, 'stop requested', reason); this.save(run);
      const testPause = Number(process.env.RG_STOP_PAUSE_MS ?? '0'); if (testPause > 0) await delay(testPause);
      let observed = await this.observed();
      for (let attempt = 0; observed.enabled && attempt < 3; attempt++) {
        try { observed = await this.command('stop', observed.generation, run); }
        catch (error) {
          if (!(error instanceof Error) || !error.message.includes('Router rejected stop: 409')) throw error;
          observed = await this.observed();
        }
      }
      if (observed.enabled) throw new Error('Control generations did not converge; withdrawal is unresolved.');
      run.generation = observed.generation; run.observedGeneration = observed.generation;
      run.plannedGeneration = observed.generation;
      const acknowledgedAt = new Date().toISOString(); this.event(run, 'stop acknowledged', 'Router acknowledges candidate withdrawal; checking subsequent version-tagged requests.'); this.save(run);
      const probes = await Promise.all(Array.from({ length: 3 }, () => this.request(run, 0.075, 'desktop', 0.5, false)));
      run.observations.push(...probes.map(probe => ({ ...probe, diagnostic: true })));
      if (probes.some(row => row.arm !== 'baseline' || row.version !== 'catalogue-stable-v1' || row.generation !== observed.generation || row.status === null || row.timeout)) throw new Error('Withdrawal could not be confirmed by subsequent requests.');
      run.rollback = { decisionAt, acknowledgedAt, confirmedAt: new Date().toISOString(), elapsedMs: performance.now() - monotonic, observedVersion: 'catalogue-stable-v1' };
      run.state = terminal; this.event(run, 'withdrawal confirmed', 'Subsequent requests reached the known-good baseline. In-flight requests may still complete.'); this.save(run);
    })();
    try { await this.stopPromise; }
    catch (error) { run.state = 'interrupted'; run.error = String(error); this.save(run); throw error; }
    finally { this.stopPromise = null; }
  }
  async reset() { await this.stop('Reset requested.'); await this.task; await this.disposeStack(); this.active = null; }
  async stopHeartbeat() { if (this.timer) clearInterval(this.timer); this.timer = null; await this.heartbeatPending; }
  async close() { await this.stopHeartbeat(); await this.reset(); this.store.close(); agent.destroy(); }
}
