import { chromium } from 'file:///D:/npqo/node_modules/playwright-core/index.mjs';
import fs from 'node:fs/promises';
const out = 'D:/qweai/artifacts/npqo-dashboard-eval-20261018/final-review-20261019';
const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
try {
  await page.goto('http://127.0.0.1:4173', { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);
  const chart = page.locator('[data-testid="equity-chart"]');
  await chart.scrollIntoViewIfNeeded();
  const box = await chart.boundingBox();
  await page.mouse.move(box.x + box.width * 0.62, box.y + box.height * 0.42);
  await page.locator('.chart-tooltip').waitFor();
  const read = () => page.evaluate(() => ({
    tick: document.querySelector('.section-meta').textContent.match(/TICK\s*(\d+)/)[1],
    tooltip: document.querySelector('.chart-tooltip').textContent,
    value: document.querySelector('.chart-tooltip strong').textContent,
    markerY: document.querySelector('.hover-dot').getAttribute('cy'),
  }));
  const before = await read();
  await page.locator('.equity-panel').screenshot({ path: out + '/hover-before.png' });
  await page.waitForTimeout(3800);
  const after = await read();
  await page.locator('.equity-panel').screenshot({ path: out + '/hover-after.png' });
  const result = { before, after, tickAdvanced: before.tick !== after.tick, markerMoved: before.markerY !== after.markerY, amountStayedStale: before.value === after.value };
  await fs.writeFile(out + '/hover-probe-results.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally { await browser.close(); }
