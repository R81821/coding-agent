import { chromium } from 'file:///D:/npqo/node_modules/playwright-core/index.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';

const out = process.argv[3] || path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1'));
await fs.mkdir(out, { recursive: true });
const baseURL = process.argv[2] || 'http://127.0.0.1:4173';
const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
const page = await context.newPage();
const errors = [];
const failures = [];
page.on('console', message => { if (message.type() === 'error' || message.type() === 'warning') errors.push({ type: message.type(), text: message.text(), location: message.location() }); });
page.on('pageerror', error => errors.push({ type: 'pageerror', text: error.message }));
page.on('requestfailed', request => failures.push({ url: request.url(), error: request.failure()?.errorText }));
page.on('response', response => { if (response.status() >= 400) failures.push({ url: response.url(), status: response.status() }); });
const checks = [];
const check = (name, pass, details) => checks.push({ name, pass, details });
const snapshot = () => page.evaluate(() => ({
  seq: Number(document.querySelector('.section-meta')?.textContent?.match(/TICK\s*(\d+)/)?.[1] ?? -1),
  balance: document.querySelector('.equity-balance')?.textContent,
  equityPath: document.querySelector('.equity-line--core')?.getAttribute('d'),
  candles: document.querySelector('[data-testid="candle-chart"]')?.innerHTML,
  activeCard: document.querySelector('.agent-card.is-active')?.getAttribute('data-agent'),
  agentValues: [...document.querySelectorAll('.agent-value')].map(el => el.textContent),
}));
const report = { baseURL, startedAt: new Date().toISOString(), checks, widths: [], errors, failures };
try {
  await page.goto(baseURL, { waitUntil: 'networkidle', timeout: 30000 });
  await page.evaluate(() => document.fonts.ready);
  await page.locator('[data-testid="agent-card"]').first().waitFor({ state: 'visible' });
  const agentIds = await page.locator('[data-testid="agent-card"]').evaluateAll(els => els.map(el => el.getAttribute('data-agent')));
  check('Eight distinct visible Agent cards', agentIds.length === 8 && new Set(agentIds).size === 8, agentIds);
  const initial = await snapshot();
  await page.waitForTimeout(11000);
  const live = await snapshot();
  check('Simulation advances without user action', live.seq > initial.seq, { initialSeq: initial.seq, liveSeq: live.seq });
  check('Equity geometry changes with the live data', !!initial.equityPath && live.equityPath !== initial.equityPath);
  check('Candlestick chart changes with live data', !!initial.candles && live.candles !== initial.candles);
  check('Agent metrics change with live data', JSON.stringify(live.agentValues) !== JSON.stringify(initial.agentValues));
  report.initial = initial;
  report.live = live;
  await page.getByRole('button', { name: 'Pause simulation', exact: true }).first().click();
  const held = await snapshot();
  await page.waitForTimeout(2300);
  const afterHold = await snapshot();
  check('Pause holds market data', afterHold.seq === held.seq && afterHold.equityPath === held.equityPath, { heldSeq: held.seq, afterHoldSeq: afterHold.seq });
  await page.getByRole('button', { name: 'Advance simulation one tick', exact: true }).first().click();
  const stepped = await snapshot();
  check('Single step advances exactly once while paused', stepped.seq === held.seq + 1 && stepped.equityPath !== held.equityPath, { heldSeq: held.seq, steppedSeq: stepped.seq });
  check('Balance is formatted as a currency amount', /^\$[\d,]+\.\d{2}$/.test((stepped.balance || '').replace(/\s/g, '')), { rendered: stepped.balance });
  const semantics = await page.evaluate(() => {
    const bayLabel = [...document.querySelectorAll('.room-svg text')].find(el => el.textContent.trim() === 'SIZE BAY');
    const bayTexts = bayLabel ? [...bayLabel.parentElement.querySelectorAll('text')].map(el => el.textContent.trim()) : [];
    const sizeCard = document.querySelector('[data-agent="size"] .agent-value')?.textContent.trim();
    const roomSize = bayTexts.find(text => /^\$[\d,]+$/.test(text));
    const volumeX = [...document.querySelectorAll('.equity-chart .volume-bar')].map(el => Number(el.getAttribute('x')));
    return { sizeCard, roomSize, bayTexts, volumeXMax: Math.max(...volumeX), volumeCount: volumeX.length, plotRight: 972 };
  });
  check('SIZE card and room display the same position size', !!semantics.roomSize && semantics.sizeCard === semantics.roomSize, semantics);
  check('Latest equity volume aligns with the latest equity tick', semantics.volumeXMax >= 950, semantics);
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    await page.waitForTimeout(300);
    const layout = await page.evaluate(() => ({
      innerWidth,
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
      bodyScrollWidth: document.body.scrollWidth,
      height: document.documentElement.scrollHeight,
      cards: [...document.querySelectorAll('[data-testid="agent-card"]')].map(el => { const r = el.getBoundingClientRect(); return { id: el.getAttribute('data-agent'), x: r.x, y: r.y, width: r.width, height: r.height }; }),
      sections: [...document.querySelectorAll('main section')].map(el => { const r = el.getBoundingClientRect(); return { label: el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') || el.className, x: r.x, y: r.y, width: r.width, height: r.height }; }),
      outOfBounds: [...document.querySelectorAll('main *')].filter(el => { const s = getComputedStyle(el); const r = el.getBoundingClientRect(); return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && (r.right > innerWidth + 1 || r.left < -1); }).slice(0, 30).map(el => ({ tag: el.tagName, class: el.getAttribute('class'), text: el.textContent?.slice(0, 60), right: el.getBoundingClientRect().right })),
    }));
    const capture = `independent-${width}.png`;
    await page.screenshot({ path: path.join(out, capture), fullPage: true });
    check(`No document overflow at ${width}px`, layout.scrollWidth <= width && layout.bodyScrollWidth <= width, layout);
    check(`All eight cards occupy readable containers at ${width}px`, layout.cards.length === 8 && layout.cards.every(c => c.width >= 150 && c.height >= 80 && c.x >= 0 && c.x + c.width <= width + 1));
    report.widths.push({ width, capture, ...layout });
  }
  check('No uncaught JavaScript exceptions', !errors.some(e => e.type === 'pageerror'), errors.filter(e => e.type === 'pageerror'));
  check('No browser console warnings or errors', errors.length === 0, errors);
  report.finishedAt = new Date().toISOString();
} catch (error) {
  report.executionError = { message: error.message, stack: error.stack };
} finally {
  await fs.writeFile(path.join(out, 'independent-browser-results.json'), JSON.stringify(report, null, 2));
  await context.close();
  await browser.close();
}
console.log(JSON.stringify({ checks: checks.map(c => ({name: c.name, pass: c.pass, details: c.pass ? undefined : c.details})), widths: report.widths.map(w => ({width: w.width, height: w.height, scrollWidth: w.scrollWidth})), errors, failures, executionError: report.executionError }, null, 2));
if (report.executionError) process.exitCode = 1;
