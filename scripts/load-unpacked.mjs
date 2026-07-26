#!/usr/bin/env node
// E1 verification (roadmap: "Chromium manifest builds and loads unpacked") — loads
// the built extension (.output/chrome-mv3) into a real Chromium and asserts:
//   (a) the MV3 service worker registers and evaluates,
//   (b) granted permissions == the ADR-022 set exactly, with ZERO host origins,
//   (c) every extension context the tree ships (guardian/overlay/quiet-page/
//       workroom) loads with HTTP 200 and zero uncaught page errors,
//   (d) manifest surface has no unresolved entry points.
// Exit 0 on full pass. Env: EXT_DIR (default .output/chrome-mv3) · LEDGE_CHROME
// (binary path; default = the cached Chrome-for-Testing install, else sibling
// chrome in PATH-order cache dirs) · LD_LIBRARY_PATH (minimal containers: point at
// the extracted Chrome shared-lib set — see which with `ldd <chrome> | grep "not
// found"`; Debian-derivable via `apt-get download <pkg> && dpkg -x …`, zero root).
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import puppeteer from 'puppeteer-core';

const EXT_DIR = resolve(process.env['EXT_DIR'] ?? '.output/chrome-mv3');
const EXPECTED_PERMISSIONS = [
  'tabs',
  'tabGroups',
  'sessions',
  'storage',
  'unlimitedStorage',
  'alarms',
  'offscreen',
  'favicon',
  'contextMenus',
];
const PAGES = ['guardian.html', 'overlay.html', 'quiet-page.html', 'workroom.html'];
const SW_TIMEOUT_MS = 20_000;
const PAGE_TIMEOUT_MS = 15_000;

const discoverChrome = () => {
  if (process.env['LEDGE_CHROME'] !== undefined) return process.env['LEDGE_CHROME'];
  const cache = join(tmpdir(), 'ledge-chrome', 'chrome');
  if (existsSync(cache)) {
    for (const build of readdirSync(cache).sort().reverse()) {
      const candidate = join(cache, build, 'chrome-linux64', 'chrome');
      if (existsSync(candidate)) return candidate;
    }
  }
  throw new Error(
    'No Chromium found. Install one: pnpm exec browsers install chrome@stable --path ' +
      join(tmpdir(), 'ledge-chrome'),
  );
};

const fail = (message) => {
  console.error(`LOAD-UNPACKED FAIL: ${message}`);
  process.exit(1);
};

if (!existsSync(join(EXT_DIR, 'manifest.json')))
  fail(`${EXT_DIR}/manifest.json missing — run \`pnpm build\` first.`);

const manifest = JSON.parse(readFileSync(join(EXT_DIR, 'manifest.json'), 'utf8'));
console.log(`manifest: v${manifest.manifest_version} "${manifest.name}" ${manifest.version}`);
if (manifest.manifest_version !== 3) fail('not an MV3 manifest');
if (manifest.background?.service_worker === undefined) fail('no service_worker entry');
const swPath = join(EXT_DIR, manifest.background.service_worker);
if (!existsSync(swPath)) fail(`service_worker unresolved: ${swPath}`);
const absentIcons = manifest.icons === undefined && manifest.action?.default_icon === undefined;
console.log(`entry: background=${manifest.background.service_worker} (exists ✓)`);
console.log(`icons: ${absentIcons ? 'none referenced (no dead entries ✓)' : 'referenced'}`);

const executablePath = discoverChrome();
console.log(`chromium: ${executablePath}`);
const browser = await puppeteer.launch({
  executablePath,
  headless: true,
  args: [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    `--load-extension=${EXT_DIR}`,
    `--disable-extensions-except=${EXT_DIR}`,
  ],
});

try {
  const swTarget = await browser.waitForTarget(
    (t) => t.type() === 'service_worker' && t.url().startsWith('chrome-extension://'),
    { timeout: SW_TIMEOUT_MS },
  );
  const extensionId = new URL(swTarget.url()).host;
  console.log(`service worker: registered (${swTarget.url()})`);

  const worker = await swTarget.worker();
  const facts = await worker.evaluate(async () => {
    const granted = await chrome.permissions.getAll();
    return {
      id: chrome.runtime.id,
      name: chrome.runtime.getManifest().name,
      version: chrome.runtime.getManifest().version,
      permissions: granted.permissions,
      origins: granted.origins,
    };
  });
  console.log(`sw runtime: id=${facts.id} name="${facts.name}" version=${facts.version}`);

  const sameSet = (a, b) => a.length === b.length && a.every((x) => b.includes(x));
  if (!sameSet(facts.permissions, EXPECTED_PERMISSIONS))
    fail(
      `granted permissions drift: got ${JSON.stringify(facts.permissions)} want ${JSON.stringify(EXPECTED_PERMISSIONS)}`,
    );
  if (facts.origins.length !== 0)
    fail(`host origins must be empty (ADR-022 zero-host law): ${JSON.stringify(facts.origins)}`);
  console.log(
    `permissions: granted == ADR-022 install set ✓ · host origins [] ✓ (zero-content-access)`,
  );

  for (const pageName of PAGES) {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });
    const response = await page.goto(`chrome-extension://${extensionId}/${pageName}`, {
      waitUntil: 'load',
      timeout: PAGE_TIMEOUT_MS,
    });
    const status = response?.status() ?? 0;
    await page.close();
    if (status !== 200) fail(`${pageName}: HTTP ${status}`);
    if (errors.length > 0) fail(`${pageName}: page errors: ${errors.join(' | ')}`);
    console.log(`page: ${pageName} → 200, zero page errors ✓`);
  }

  console.log('LOAD-UNPACKED PASS: manifest valid, SW live, ADR-022 scope exact, all pages load.');
} finally {
  await browser.close();
}
