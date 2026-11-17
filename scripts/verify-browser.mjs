import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { gzipSync } from 'node:zlib';
import AxeBuilder from '@axe-core/playwright';

const base = process.env.TEST_BASE_URL || 'http://127.0.0.1:4318';
const output = new URL('../docs/screenshots/', import.meta.url);
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : process.platform === 'win32' ? { channel: 'msedge' } : {}) });
const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, reducedMotion: 'reduce' });
const page = await context.newPage();
page.setDefaultTimeout(120000);
const report = { capturedAt: new Date().toISOString(), browser: browser.version(), platform: process.platform, checks: [], views: [], errors: [], passed: false };
page.on('pageerror', error => report.errors.push(error.message));
function check(name) { report.checks.push(name); process.stdout.write(`Passed: ${name}\n`); }
async function scan(name) {
  for (const width of [360, 768, 1440]) {
    await page.setViewportSize({ width, height: 1100 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${name} overflow ${width}`);
    const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
    report.views.push({ name, width, violations: result.violations.map(({ id, nodes }) => ({ id, targets: nodes.map(node => node.target) })) });
    assert.deepEqual(result.violations, [], `${name} axe ${width}`);
    await page.screenshot({ path: new URL(`${name}-${width}.png`, output).pathname.replace(/^\/(\w:)/, '$1'), fullPage: true });
  }
  check(`${name}: three responsive views, no page overflow or automated WCAG-tagged findings`);
}
try {
  await page.goto(base);
  await page.getByRole('button', { name: 'Start canary' }).waitFor();
  await page.getByRole('button', { name: 'Reset workbench', exact: true }).click();
  await page.getByRole('heading', { name: 'A little traffic. A considered decision.' }).waitFor();
  await page.keyboard.press('Tab');
  await page.locator('.skip').focus();
  await page.keyboard.press('Enter');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'main');
  check('Keyboard skip link focuses workbench');
  await scan('initial');
  await page.getByText('Inspect the decision rules', { exact: true }).click();
  assert.equal(await page.getByText('Minimum / cohort').isVisible(), true);
  await page.getByText('Inspect the decision rules', { exact: true }).click();
  check('Policy disclosure exposes frozen sample and health requirements');
  await page.getByRole('button', { name: 'Start canary' }).click();
  await page.getByRole('heading', { name: 'Evidence supports the next step.' }).waitFor();
  check('Real healthy 5% stage reaches eligible decision');
  await scan('eligible');
  const initial = await (await fetch(`${base}/api/state`)).json();
  assert.equal(initial.active.stage, 0);
  assert.equal(initial.active.decision.status, 'eligible to advance');
  await page.reload();
  await page.getByRole('heading', { name: 'Evidence supports the next step.' }).waitFor();
  check('Reload preserves active run and explicit advancement');
  await page.getByRole('button', { name: 'Advance to 25%' }).click();
  await page.getByRole('button', { name: 'Advance to 50%' }).waitFor();
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some(button => button.textContent === 'Advance to 50%' && !button.disabled));
  await page.getByRole('button', { name: 'Advance to 50%' }).click();
  await page.getByRole('heading', { name: 'All three stages passed.' }).waitFor();
  check('Explicit 25% and 50% advancement completes all stages');
  const complete = await (await fetch(`${base}/api/state`)).json();
  assert.equal(complete.active.state, 'completed');
  assert.equal(complete.active.rollback.observedVersion, 'catalogue-stable-v1');
  const packet = await (await fetch(`${base}/api/runs/${complete.active.id}/export`)).json();
  assert.ok(packet.run.observations.length > 0);
  assert.equal(packet.mode, 'live HTTP capture');
  await writeFile(new URL('../docs/browser-run-evidence.json.gz', import.meta.url), gzipSync(JSON.stringify(packet)));
  check('Export includes real request evidence and observed withdrawal');
  await scan('completed');
  await page.getByRole('combobox', { name: 'Scenario', exact: true }).selectOption('missing-metrics');
  await page.getByRole('button', { name: 'Start canary' }).click();
  await page.getByRole('heading', { name: 'There is not enough evidence to advance.' }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Advance to 25%' }).isDisabled(), true);
  await page.getByText('Withdrawal observed', { exact: false }).waitFor();
  check('Missing telemetry holds advancement and confirms withdrawal');
  await scan('inconclusive');
  await page.getByRole('combobox', { name: 'Scenario', exact: true }).selectOption('healthy');
  await page.getByRole('button', { name: 'Start canary' }).click();
  await page.getByRole('button', { name: 'Stop candidate traffic' }).click();
  await page.getByText('Withdrawal observed', { exact: false }).waitFor();
  check('Manual stop is functional and independently observed');
  assert.deepEqual(report.errors, []);
  report.passed = true;
} finally {
  await writeFile(new URL('../docs/browser-verification.json', import.meta.url), JSON.stringify(report, null, 2));
  await browser.close();
}
