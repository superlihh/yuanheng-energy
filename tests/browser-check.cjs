const { chromium } = require('C:/Users/12237/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const fs = require('node:fs');
const path = require('node:path');

const baseUrl = process.env.BROWSER_BASE_URL || 'http://127.0.0.1:18080';
const qaRoot = path.resolve('.qa');
fs.mkdirSync(qaRoot, { recursive: true });

(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', dialog => dialog.accept());

  await page.goto(baseUrl + '/', { waitUntil: 'domcontentloaded', timeout: 15000 });
  await page.locator('#auth-wall').waitFor({ state: 'visible' });
  await page.locator('#live-auth-switch').click();
  const username = 'browser_' + Date.now();
  const captcha = (await page.locator('#live-captcha-code').textContent()).trim();
  await page.locator('#live-username').fill(username);
  await page.locator('#live-email').fill(username + '@example.invalid');
  await page.locator('#live-password').fill('Test-Only-Password-2026');
  await page.locator('#live-captcha').fill(captcha);
  await page.locator('#live-auth-submit').click();
  await page.locator('#auth-wall').waitFor({ state: 'hidden', timeout: 15000 });
  // Registration/login can preserve the previous hash or land on another
  // workspace view. Select the operations view explicitly before checking its map.
  await page.locator('[data-view="operations"]').click({ force: true });
  await page.locator('#ops-map svg').waitFor({ state: 'visible', timeout: 15000 });

  const views = await page.locator('.nav a[data-view]').evaluateAll(nodes => nodes.map(node => node.dataset.view));
  for (const view of views) {
    if (['devices', 'terminal', 'schedule', 'alerts', 'longterm', 'governance', 'explain'].includes(view)) {
      const menu = page.locator('.nav-more-tools');
      await menu.evaluate(element => { element.open = true; });
    }
    await page.locator(`.nav a[data-view="${view}"]`).click({ force: true });
    await page.locator('#view-' + view).waitFor({ state: 'visible' });
  }

  await page.locator('[data-view="data"]').click();
  await page.locator('#demo-btn').click();
  await page.locator('#batch-table').waitFor({ state: 'visible' });
  await page.waitForFunction(() => document.querySelectorAll('#batch-table tbody tr').length > 0, null, { timeout: 15000 });
  const batchRows = await page.locator('#batch-table tbody tr').count();

  await page.locator('[data-view="assistant"]').click();
  await page.locator('#assistant-input').fill('今天哪个区域负荷最高？');
  await page.locator('#assistant-form button[type="submit"]').click();
  await page.locator('.assistant-msg.bot .assistant-answer-card, .assistant-msg.bot .assistant-error-card').last().waitFor({ state: 'visible', timeout: 20000 });
  const assistantCards = await page.locator('.assistant-msg.bot').count();
  try { await page.screenshot({ path: path.join(qaRoot, 'current-assistant.png'), fullPage: true, timeout: 5000 }); } catch (_) { /* external fonts may keep screenshot waiting */ }

  const importCsv = path.join(qaRoot, 'browser-import.csv');
  fs.writeFileSync(importCsv, '\uFEFFtimestamp,price_yuan_mwh,load_kw\n2026-11-11 00:00,280,420\n2026-11-11 01:00,275,410\n', 'utf8');
  await page.locator('#assistant-file').setInputFiles(importCsv);
  await page.locator('#assistant-upload-preview').waitFor({ state: 'visible' });
  const previewStatus = await page.locator('#assistant-upload-preview .tag').textContent();
  await page.locator('[data-upload-action="cancel"]').click();

  await page.locator('[data-view="devices"]').click();
  await page.locator('#load-device-demo').click();
  await page.waitForTimeout(700);
  const deviceCards = await page.locator('#device-list .device-card').count();
  await page.locator('[data-view="compare"]').click();
  const schemeCards = await page.locator('#scheme-cards > *').count();
  await page.locator('[data-view="governance"]').click();
  await page.locator('#gov-catalog-table').waitFor({ state: 'visible' });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('[data-view="operations"]').click();
  const horizontalOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 2);
  try { await page.screenshot({ path: path.join(qaRoot, 'current-mobile.png'), fullPage: true, timeout: 5000 }); } catch (_) { /* layout assertions still run */ }
  await fs.promises.writeFile(path.join(qaRoot, 'browser-result.json'), JSON.stringify({ errors, views, batchRows, assistantCards, previewStatus, deviceCards, schemeCards, horizontalOverflow }, null, 2));
  console.log(JSON.stringify({ errors, views, batchRows, assistantCards, previewStatus, deviceCards, schemeCards, horizontalOverflow }));
  await browser.close();
  if (errors.length || horizontalOverflow || batchRows < 1 || assistantCards < 2 || previewStatus !== '可预览') process.exit(1);
})().catch(error => { console.error(error); process.exit(1); });
