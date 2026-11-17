import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const base = process.env.TEST_BASE_URL || 'http://127.0.0.1:4318';
const output = new URL('../docs/', import.meta.url);
const videoDirectory = new URL('../artifacts/video/', import.meta.url);
await mkdir(videoDirectory, { recursive: true });
const browser = await chromium.launch({ headless: true, ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : process.platform === 'win32' ? { channel: 'msedge' } : {}) });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce', recordVideo: { dir: fileURLToPath(videoDirectory), size: { width: 1440, height: 1000 } } });
const page = await context.newPage();
page.setDefaultTimeout(120000);
const captions = [];
const started = performance.now();
const seconds = () => (performance.now() - started) / 1000;
const holdUntil = async time => { const wait = time - seconds(); if (wait > 0) await page.waitForTimeout(wait * 1000); };
async function caption(text) {
  captions.push({ start: seconds(), text });
  await page.evaluate(text => {
    let overlay = document.getElementById('walkthrough-caption');
    if (!overlay) {
      overlay = document.createElement('div'); overlay.id = 'walkthrough-caption';
      overlay.style.cssText = 'position:fixed;bottom:20px;left:8%;right:8%;z-index:1000;background:#192e27;color:#f4f6ea;border:1px solid #a1b88a;border-radius:8px;padding:18px 25px;font:18px/1.5 system-ui;text-align:center;box-shadow:0 4px 20px #0003;pointer-events:none';
      document.body.append(overlay);
    }
    overlay.textContent = text;
  }, text);
}
const timestamp = seconds => new Date(seconds * 1000).toISOString().slice(11, 23);
try {
  await page.goto(base);
  await page.getByRole('button', { name: 'Reset workbench', exact: true }).click();
  await page.getByRole('heading', { name: 'A little traffic. A considered decision.' }).waitFor();
  await caption('ReleaseGuard runs a real local experiment: a router, a stable service, a fresh baseline, and a candidate. All traffic is synthetic.');
  await holdUntil(7);
  await page.getByRole('combobox', { name: 'Scenario', exact: true }).selectOption('healthy');
  await page.getByRole('button', { name: 'Start canary' }).click();
  await caption('Policy is frozen before traffic starts. The first stage sends 5% to each comparison arm, with 90% going to the stable service.');
  await page.getByRole('heading', { name: 'Evidence supports the next step.' }).waitFor();
  await holdUntil(20);
  await page.getByRole('region', { name: 'Cohort comparison evidence' }).scrollIntoViewIfNeeded();
  await caption('Healthy is earned: every cohort needs enough evidence, a healthy baseline, and an upper degradation bound within tolerance. Advancement is explicit.');
  await holdUntil(31);
  await page.getByRole('button', { name: 'Stop candidate traffic' }).click();
  await page.getByText('Withdrawal observed', { exact: false }).waitFor();
  await page.locator('.rollback').scrollIntoViewIfNeeded();
  await caption('Stopping is checked against the real router. Subsequent requests must return the baseline version before withdrawal is recorded as confirmed.');
  await holdUntil(41);
  await page.evaluate(() => scrollTo(0, 0));
  await page.getByRole('combobox', { name: 'Scenario', exact: true }).selectOption('missing-metrics');
  await page.getByRole('button', { name: 'Start canary' }).click();
  await caption('Now lose the candidate telemetry. Missing measurements must not become zero errors or zero latency.');
  await page.getByRole('heading', { name: 'There is not enough evidence to advance.' }).waitFor();
  await holdUntil(53);
  await page.getByRole('region', { name: 'Cohort comparison evidence' }).scrollIntoViewIfNeeded();
  await caption('The run is inconclusive. Advancement stays locked, and candidate traffic is withdrawn after the frozen grace period. This is not a statistical regression claim.');
  await holdUntil(64);
  await page.evaluate(() => scrollTo(0, 0));
  await caption('Export includes the policy, raw requests, judgments, and control events. Reanalyze the saved inputs to reproduce the same decision.');
  await holdUntil(75);
  const duration = seconds();
  await writeFile(new URL('walkthrough.vtt', output), 'WEBVTT\n\n' + captions.map((item, index) => `${index + 1}\n${timestamp(item.start)} --> ${timestamp(captions[index + 1]?.start ?? duration)}\n${item.text}\n`).join('\n'));
  await writeFile(new URL('walkthrough-capture.json', output), JSON.stringify({ capturedAt: new Date().toISOString(), mode: 'live local HTTP application, caption overlay only', browser: browser.version(), durationSeconds: duration, captions }, null, 2));
  const video = page.video();
  await context.close();
  await video.saveAs(fileURLToPath(new URL('walkthrough.webm', output)));
} finally { await browser.close(); }
