import assert from 'node:assert/strict';
import { createReadStream, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { createGunzip, gunzipSync } from 'node:zlib';
import { z } from 'zod';
import { analyze } from '../src/analysis.ts';
import { compactSchema, decode } from './encoding.ts';

const report = z.object({ results: z.array(z.object({ id: z.string(), judgments: z.array(z.unknown()) })) })
  .parse(JSON.parse(gunzipSync(readFileSync(new URL('./results/simulation-results.json.gz', import.meta.url))).toString()));
const lines = createInterface({ input: createReadStream(new URL('./results/inputs.ndjson.gz', import.meta.url)).pipe(createGunzip()), crlfDelay: Infinity });
let count = 0;
for await (const line of lines) {
  const input = decode(compactSchema.parse(JSON.parse(line)));
  const saved = report.results.find(result => result.id === input.case);
  assert.ok(saved);
  for (const checkpoint of input.checkpoints) {
    const actual = analyze(input.policy, input.observations.slice(0, checkpoint * 2), {
      stage: input.stage, checkpoint, controlResolved: true, workloadComparable: true, telemetryFresh: true });
    assert.ok(saved.judgments.some(judgment => JSON.stringify(judgment) === JSON.stringify(actual)), `${input.case}/${input.stage}/${checkpoint} did not reproduce`);
    count++;
  }
}
process.stdout.write(`Exactly reproduced ${count} recorded checkpoint judgments from compact raw inputs.\n`);
