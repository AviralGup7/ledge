// E8-T06 · BuiltIn degrade e2e — the row's completion evidence ("absence =
// invisible degrade (e2e)") against a REAL Chromium in the stock posture
// (Chrome-for-Testing ships no ready LanguageModel, and Ledge never triggers
// a download — K1). Proven with every artifact real:
//   ParkWindow on two titled pages ⇒ the mission is named COHERENTLY (the
//   honest on-device/heuristic frame answers — degrade never reaches the
//   user), the quiet page shows NO alert/banner, and the ai-lanes probe
//   reports zero failures / zero rejections / zero open breakers. The
//   adapter's absence leaves no trace anywhere except honest answers.
//
// DECLARED LONG-RUNNING: full Chromium boots + real park flow + job drain.
// The 240s project-level testTimeout (vitest.config.ts) is the lane's
// declared exception to the 60s single-test house law. Runs in the e2e lane
// only (`pnpm test:e2e`), never in the unit lane.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import puppeteer, { type Browser, type Page } from 'puppeteer-core';

const EXT_DIR = resolve('.output/chrome-mv3');
const CLIENT_BUNDLE = resolve('ops/tests/e2e/client.js');
const QUIET_PAGE = 'quiet-page.html';
const SW_WAIT_MS = 20_000;
const CLIENT_BOOT_WAIT_MS = 15_000;
const POLL_TRIES = 60;
const POLL_STEP_MS = 500;
const SETTLE_MS = 2_000;
const PAGE_TITLE_A = 'Merged pull request on github';
const PAGE_TITLE_B = 'GitHub notifications center';

// ─── server pages (real titles, real http) ───────────────────────────────────
const pageHtml = (title: string): string =>
  `<!doctype html><html><head><title>${title}</title></head><body><h1>${title}</h1></body></html>`;

// ─── chromium discovery (verbatim mirrors scripts/load-unpacked.mjs) ─────────
const discoverChrome = (): string => {
  const envPath = process.env['LEDGE_CHROME'];
  if (envPath !== undefined && envPath.length > 0) return envPath;
  const cache = join(tmpdir(), 'ledge-chrome', 'chrome');
  if (existsSync(cache)) {
    for (const build of readdirSync(cache).sort().reverse()) {
      const candidate = join(cache, build, 'chrome-linux64', 'chrome');
      if (existsSync(candidate)) return candidate;
    }
  }
  throw new Error(
    `No Chromium found for the e2e lane. Install: pnpm exec browsers install chrome@stable --path ${join(tmpdir(), 'ledge-chrome')}`,
  );
};

const CHROME = discoverChrome();

const extensionIdFromPath = (extDir: string): string => {
  const digest = createHash('sha256').update(extDir, 'utf8').digest();
  let id = '';
  for (const byte of digest.subarray(0, 16)) {
    id += String.fromCharCode('a'.charCodeAt(0) + Math.floor(byte / 16));
    id += String.fromCharCode('a'.charCodeAt(0) + (byte % 16));
  }
  return id;
};

const launch = (profile: string): Promise<Browser> =>
  puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    protocolTimeout: 600_000,
    userDataDir: profile,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      `--load-extension=${EXT_DIR}`,
      `--disable-extensions-except=${EXT_DIR}`,
    ],
  });

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

import type { LedgeE2EClient, RoundTrip } from './client-entry.js';

declare global {
  interface Window {
    __ledgeE2E?: LedgeE2EClient;
  }
}

const attachClient = async (page: Page): Promise<void> => {
  const source = readFileSync(CLIENT_BUNDLE, 'utf8');
  await page.evaluate(source);
  await page.waitForFunction('window.__ledgeE2E !== undefined', {
    timeout: CLIENT_BOOT_WAIT_MS,
  });
};

const openClientPage = async (browser: Browser, extensionId: string): Promise<Page> => {
  const page = await browser.newPage();
  await page.goto(`chrome-extension://${extensionId}/${QUIET_PAGE}`, { waitUntil: 'load' });
  await attachClient(page);
  return page;
};

const waitSw = async (browser: Browser, timeoutMs: number): Promise<string | null> => {
  try {
    const target = await browser.waitForTarget(
      (t) => t.type() === 'service_worker' && t.url().startsWith('chrome-extension://'),
      { timeout: timeoutMs },
    );
    return new URL(target.url()).host;
  } catch {
    return null;
  }
};

const sendQuery = (page: Page, name: string, payload: unknown): Promise<RoundTrip> =>
  page.evaluate(
    (n, p) => {
      const api = window.__ledgeE2E;
      if (api === undefined) throw new Error('e2e client missing');
      return api.sendQuery(n, p);
    },
    name,
    payload,
  );

const sendCommand = (page: Page, name: string, payload: unknown): Promise<RoundTrip> =>
  page.evaluate(
    (n, p) => {
      const api = window.__ledgeE2E;
      if (api === undefined) throw new Error('e2e client missing');
      return api.sendCommand(n, p);
    },
    name,
    payload,
  );

/** Poll a query until `until(value)` holds (job drains are asynchronous). */
const pollQuery = async (
  page: Page,
  name: string,
  payload: unknown,
  until: (value: unknown) => boolean,
  what: string,
): Promise<unknown> => {
  let last: unknown = null;
  for (let i = 0; i < POLL_TRIES; i += 1) {
    try {
      const trip = await sendQuery(page, name, payload);
      if (trip.ack.outcome === 'ack' && trip.terminal.ok && until(trip.terminal.value)) {
        return trip.terminal.value;
      }
      last = trip.terminal.ok ? trip.terminal.value : trip.terminal.error;
    } catch (cause) {
      last = String(cause);
    }
    await sleep(POLL_STEP_MS);
  }
  throw new Error(`pollQuery(${name}) for ${what} never satisfied; last=${JSON.stringify(last)}`);
};

interface PeekTab {
  readonly browserTabId: number;
  readonly windowId: number;
  readonly title: string;
}

interface MissionRow {
  readonly missionId: string;
  readonly name: string;
  readonly state: string;
}

describe('E8-T06 · BuiltIn absence is an invisible degrade (real Chromium)', () => {
  let server: Server;
  let origin: string;
  let profile: string;
  let browser: Browser | undefined;

  beforeAll(async () => {
    server = createServer((req, res) => {
      res.setHeader('content-type', 'text/html');
      res.end(req.url === '/b' ? pageHtml(PAGE_TITLE_B) : pageHtml(PAGE_TITLE_A));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no server address');
    origin = `http://127.0.0.1:${address.port}`;
    profile = mkdtempSync(join(tmpdir(), 'ledge-e2e-builtin-'));
  });

  afterAll(async () => {
    await browser?.close().catch(() => undefined);
    server.close();
    rmSync(profile, { recursive: true, force: true });
  });

  it('park ⇒ coherent name, zero banners, ai-lanes spotless — absence leaves no trace', async () => {
    browser = await launch(profile);
    const extensionId = extensionIdFromPath(EXT_DIR);
    // Stock posture note: if a future Chromium exposes a READY LanguageModel,
    // the invariant assertions below STILL hold (ready ⇒ better names; absent
    // ⇒ honest frame) — the test keys on user-visible truth, never on posture.
    const swId = await waitSw(browser, SW_WAIT_MS);
    expect(swId === null || swId === extensionId).toBe(true);

    // Two titled pages (park scope = THEIR window id, found via PeekOpenTabs).
    const tabA = await browser.newPage();
    await tabA.goto(`${origin}/a`, { waitUntil: 'load' });
    const tabB = await browser.newPage();
    await tabB.goto(`${origin}/b`, { waitUntil: 'load' });

    // Park via the real wire: find the window carrying page A, park it.
    const quiet = await openClientPage(browser, extensionId);
    const parked = await sendQuery(quiet, 'PeekOpenTabs', {});
    expect(parked.terminal.ok).toBe(true);
    const tabs = (parked.terminal.ok ? parked.terminal.value : []) as readonly PeekTab[];
    const mine = tabs.find((t) => t.title === PAGE_TITLE_A);
    if (mine === undefined) throw new Error(`page A not in PeekOpenTabs: ${JSON.stringify(tabs)}`);
    const command = await sendCommand(quiet, 'ParkWindow', { windowId: mine.windowId });
    expect(command.ack.outcome).toBe('ack');
    expect(command.terminal.ok).toBe(true);
    const applied = (command.terminal.ok ? command.terminal.value : {}) as Readonly<
      Record<string, unknown>
    >;
    const missionId = applied['missionId'];
    expect(typeof missionId).toBe('string');

    // The name arrives when the naming lane drains (interactive ≤2.5s budget).
    await sleep(SETTLE_MS);
    const named = (await pollQuery(
      quiet,
      'GetLibrary',
      {},
      (value) => {
        const rows = (value as { missions?: readonly MissionRow[] }).missions ?? [];
        const found = rows.find((m) => m.missionId === missionId);
        return found !== undefined && found.name.length > 0;
      },
      'the parked mission with a coherent name',
    )) as { readonly missions: readonly MissionRow[] };
    const mission = named.missions.find((m) => m.missionId === missionId);
    // Coherence law: SOME honest frame answered — never a placeholder, never
    // an error string, never empty. (Model classes vary by posture; the
    // user-visible truth does not.)
    expect(mission?.name.toLowerCase()).not.toContain('unnamed');
    expect(mission?.name.toLowerCase()).not.toContain('error');

    // Invisible degrade at the health surface: the ai-lanes probe is spotless.
    const healthTrip = await sendQuery(quiet, 'GetHealth', {});
    expect(healthTrip.terminal.ok).toBe(true);
    const health = (healthTrip.terminal.ok ? healthTrip.terminal.value : {}) as Readonly<
      Record<string, unknown>
    >;
    const probes = (health['probes'] ?? {}) as Readonly<Record<string, unknown>>;
    const aiLanes = (probes['ai-lanes'] ?? {}) as Readonly<Record<string, unknown>>;
    const fields = (aiLanes['fields'] ?? {}) as Readonly<Record<string, unknown>>;
    expect(fields['failed']).toBe(0);
    expect(fields['rejected']).toBe(0);
    expect(fields['breakersOpen']).toBe('none');

    // And the calm surface: no alert, no banner — absence never reaches the user.
    const alerts = await quiet.$$eval('[role="alert"]', (nodes) => nodes.length);
    expect(alerts).toBe(0);
    await tabA.close().catch(() => undefined);
    await tabB.close().catch(() => undefined);
    await quiet.close().catch(() => undefined);
  });
});
