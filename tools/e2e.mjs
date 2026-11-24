#!/usr/bin/env node
// tools/e2e.mjs -- End-to-end smoke test of the page in headless Chromium (Playwright)
//
// Usage:  node tools/e2e.mjs [--out <dir>]     (screenshots go to <dir>, default os.tmpdir())
// Serves the repository with a tiny static server, opens the page on desktop and phone viewports,
// exercises the controls, the URL hash, the exports and the methodology page, and fails on any
// console error or failed check.

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium, devices } = require('playwright');
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2', '.png': 'image/png', '.md': 'text/plain; charset=utf-8'
};

/**
 * Start a static file server for the repository on a free port.
 * Inputs:  none
 * Output:  Promise<{ server: http.Server, baseUrl: string }>
 * Example: const { server, baseUrl } = await startServer();
 */
function startServer() {
  const server = http.createServer((request, response) => {
    const urlPath = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    const filePath = path.join(REPO_ROOT, urlPath.endsWith('/') ? urlPath + 'index.html' : urlPath);
    if (!filePath.startsWith(REPO_ROOT) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      response.writeHead(404);
      response.end('not found');
      return;
    }
    response.writeHead(200, { 'Content-Type': CONTENT_TYPES[path.extname(filePath)] || 'application/octet-stream' });
    fs.createReadStream(filePath).pipe(response);
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}` })));
}

/**
 * Run the end-to-end checks.
 * Inputs:  outDir (string, directory for screenshots)
 * Output:  Promise<number> (count of failed checks)
 * Example: const failures = await runE2e('/tmp/shots');
 */
async function runE2e(outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const { server, baseUrl } = await startServer();
  const browser = await chromium.launch();
  const failures = [];
  const expect = (name, passed, detail = '') => {
    console.log(`  ${passed ? 'OK  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
    if (!passed) failures.push(name);
  };
  const consoleErrors = [];
  const watch = page => {
    page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
    page.on('pageerror', error => consoleErrors.push(error.message));
    // the Google Fonts stylesheet is optional; block it so the test does not depend on the network
    page.route(/fonts\.(googleapis|gstatic)\.com/, route => route.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  };
  const waitForResult = page => page.waitForFunction(() => {
    const value = document.getElementById('kpiRatioValue');
    return document.documentElement.dataset.state === 'ready' && value && value.textContent.trim() !== '—'
      && document.querySelector('#pyramidContainer svg');
  }, null, { timeout: 15000 });

  try {
    // Desktop
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, acceptDownloads: true });
    const page = await context.newPage();
    watch(page);
    await page.goto(`${baseUrl}/index.html`);
    await waitForResult(page);
    const initialRatio = await page.textContent('#kpiRatioValue');
    const initialPopulation = await page.textContent('#statTotal');
    expect('Stránka sa načíta a vypočíta základný scenár', Boolean(initialRatio), `poberatelia/100 platiteľov ${initialRatio}, populácia ${initialPopulation}`);
    expect('Formát sk-SK (desatinná čiarka)', /,/.test(await page.textContent('#statMeanAge')), await page.textContent('#statMeanAge'));
    const badgeVisible = await page.isVisible('#calibrationBadge');
    expect('Odznak stavu kalibrácie je viditeľný', badgeVisible, await page.textContent('#calibrationBadge'));
    const sliderCount = await page.locator('.controls input[type="range"]').count();
    expect('Posuvníky vytvorené z konfigurácie', sliderCount === 13, `${sliderCount} posuvníkov`);
    await page.screenshot({ path: path.join(outDir, 'desktop-2024.png') });

    // Change TFR -> new simulation, scenario becomes custom, hash updated
    await page.locator('#slider-tfrTarget').fill('1.9');
    await page.waitForFunction(() => location.hash.includes('tfr=1.9'));
    await waitForResult(page);
    expect('Zmena posuvníka zapíše stav do URL', (await page.evaluate(() => location.hash)).includes('tfr=1.9'));
    expect('Scenár sa prepne na vlastné nastavenie', (await page.inputValue('#scenarioSelect')) === 'custom');

    // Year 2060
    await page.locator('#yearSlider').fill('2060');
    await page.waitForFunction(() => document.getElementById('yearDisplay').textContent === '2060');
    const ratio2060 = await page.textContent('#kpiRatioValue');
    expect('Posun roka prekreslí pyramídu a ukazovatele', ratio2060 !== initialRatio, `2060: ${ratio2060}`);

    // Legend toggle
    await page.locator('.legend-item').first().click();
    expect('Legenda skryje kategóriu', (await page.getAttribute('.legend-item >> nth=0', 'aria-pressed')) === 'false');

    // Reload with the hash -> same state
    const hash = await page.evaluate(() => location.hash);
    await page.goto(`${baseUrl}/index.html${hash}`);
    await waitForResult(page);
    expect('Odkaz s hashom obnoví stav', (await page.inputValue('#slider-tfrTarget')) === '1.9' && (await page.textContent('#yearDisplay')) === '2060', hash);

    // Scenario preset
    await page.selectOption('#scenarioSelect', 'retirementPlus2');
    await waitForResult(page);
    expect('Scenár „Dôchodkový vek +2“ nastaví posuvníky', (await page.textContent('#value-retireAgeMale')).startsWith('65'), await page.textContent('#value-retireAgeMale'));

    // Exports
    for (const [kind, extension] of [['series', '.csv'], ['pyramid', '.csv'], ['png', '.png'], ['svg', '.svg']]) {
      await page.click('#exportButton');
      const [download] = await Promise.all([page.waitForEvent('download', { timeout: 10000 }), page.click(`[data-export="${kind}"]`)]);
      const target = path.join(outDir, `export-${kind}${extension}`);
      await download.saveAs(target);
      const size = fs.statSync(target).size;
      expect(`Export ${kind}`, size > 500 && download.suggestedFilename().endsWith(extension), `${download.suggestedFilename()}, ${size} B`);
    }
    const seriesCsv = fs.readFileSync(path.join(outDir, 'export-series.csv'), 'utf8').replace(/^﻿/, '').split('\n');
    expect('CSV časových radov: hlavička + 77 rokov', seriesCsv[0].startsWith('rok,obyvatelstvo_tis') && seriesCsv.filter(Boolean).length === 78, `${seriesCsv.filter(Boolean).length} riadkov`);

    // Reset
    await page.click('#resetButton');
    await waitForResult(page);
    expect('Reset vráti predvolené hodnoty a rok', (await page.inputValue('#scenarioSelect')) === 'base' && (await page.textContent('#yearDisplay')) === '2024');

    // Time-series metric
    await page.selectOption('#metricSelect', 'population');
    await page.waitForTimeout(200);
    expect('Graf časového vývoja sa prepne', (await page.locator('#seriesContainer svg').count()) > 0);
    await page.locator('#yearSlider').fill('2070');
    await page.waitForTimeout(250);
    await page.screenshot({ path: path.join(outDir, 'desktop-2070.png') });
    await context.close();

    // Phone
    const phone = await browser.newContext({ ...devices['iPhone 13'] });
    const phonePage = await phone.newPage();
    watch(phonePage);
    await phonePage.goto(`${baseUrl}/index.html#y=2050`);
    await waitForResult(phonePage);
    const overflow = await phonePage.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect('Mobil: bez horizontálneho posúvania', overflow <= 1, `presah ${overflow}px`);
    await phonePage.screenshot({ path: path.join(outDir, 'phone-2050.png'), fullPage: true });
    await phonePage.click('#toggleControls');
    expect('Mobil: panel predpokladov sa otvorí', await phonePage.isVisible('#slider-tfrTarget'));
    await phonePage.screenshot({ path: path.join(outDir, 'phone-controls.png') });
    await phone.close();

    // Methodology page
    if (fs.existsSync(path.join(REPO_ROOT, 'metodika.html'))) {
      const docs = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      const docsPage = await docs.newPage();
      watch(docsPage);
      await docsPage.goto(`${baseUrl}/metodika.html`);
      await docsPage.waitForFunction(() => document.querySelectorAll('.katex').length > 5, null, { timeout: 10000 });
      const formulaCount = await docsPage.locator('.katex').count();
      expect('Metodika: vzorce vykreslené (KaTeX)', formulaCount > 5, `${formulaCount} vzorcov`);
      await docsPage.waitForFunction(() => document.querySelectorAll('#calibrationTable tbody tr').length > 3, null, { timeout: 10000 });
      expect('Metodika: tabuľka stavu kalibrácie', (await docsPage.locator('#calibrationTable tbody tr').count()) > 3);
      await docsPage.screenshot({ path: path.join(outDir, 'metodika.png') });
      await docs.close();
    }

    expect('Žiadne chyby v konzole', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
  } finally {
    await browser.close();
    server.close();
  }
  console.log(failures.length ? `\n${failures.length} kontrol(y) zlyhali.` : `\nVšetky e2e kontroly prešli. Screenshoty: ${outDir}`);
  return failures.length;
}

const outIndex = process.argv.indexOf('--out');
const outDir = outIndex >= 0 ? path.resolve(process.argv[outIndex + 1]) : fs.mkdtempSync(path.join(os.tmpdir(), 'rrz-e2e-'));
runE2e(outDir).then(failures => { process.exitCode = failures ? 1 : 0; }, error => { console.error(error); process.exitCode = 1; });
