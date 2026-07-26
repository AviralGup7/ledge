// E6-T01 · REAL-RESTART e2e lane — W7 recovery flow + §14.4 card gating against a
// real Chromium and real browser death (roadmap completion evidence: "real-restart
// e2e; exact catalog copy"; EES §6 e2e line: puppeteer-class, load-unpacked,
// PR-smoke + nightly; §8 lane law: lives outside the default unit lane — run via
// `pnpm test:e2e` only).
//
// DECLARED LONG-RUNNING: every scenario runs full Chromium boot ⇒ SIGKILL ⇒
// relaunch cycles. The 240s project-level testTimeout (vitest.config.ts) is the
// lane's declared exception to the 60s single-test house law.
//
// Proven here (all artifacts real — the only harness act is precondition seeding):
//   A. crash-with-damage ⇒ THE CARD: install boot announces clean-abnormal →
//      harness plants the crash-side world into the extension's REAL IndexedDB
//      (one dangling universal-kind intent — no lawful abort row ⇒ reconciler
//      defers ⇒ loss-risk — plus one live mission with three live tab rows) →
//      real SIGKILL → relaunch ⇒ marker classifies 'crashed', reconcile defers
//      the intent ⇒ §14.4 gates TRUE ⇒ the recovery card appears in a quiet tab
//      with EXACT catalog copy (template-anchored, params wildcarded) ⇒
//      "Put everything back" reopens all three URLs as real browser tabs ⇒
//      resolved line ⇒ incident slot settles (pending:false).
//   B. graceful close ⇒ NO CARD: relaunch announces clean-abnormal (the
//      conservative compass classifies any non-update end as 'crashed') and the
//      §14.4 negative gate holds — no card tab, pending:false.
//
// Not re-litigated here: classifier tables, slot merge law, copy grammar — those
// are unit/integration-proven; this lane exists to prove the W7 flow survives a
// real browser death with the real leveldb, real markers, and the real SW.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import puppeteer, { type Browser, type Page } from 'puppeteer-core';

// ─── lane constants (named per house law; tests are magic-number-exempt but these
//     carry meaning worth naming) ───────────────────────────────────────────────
const EXT_DIR = resolve('.output/chrome-mv3');
const CLIENT_BUNDLE = resolve('ops/tests/e2e/client.js');
const CATALOG_PATH = resolve('src/surfaces/components/copy/catalog.json');
const QUIET_PAGE = 'quiet-page.html';
const IDB_NAME = 'ledge';
const SW_WAIT_MS = 20_000;
const WAKE_RETRY_WAIT_MS = 12_000;
const CLIENT_BOOT_WAIT_MS = 15_000;
const CARD_WAIT_MS = 45_000;
const POLL_TRIES = 40;
const POLL_STEP_MS = 500;
const TARGET_POLL_MS = 250;
const RESOLVED_WAIT_MS = 20_000;
const NEGATIVE_OBSERVE_MS = 6_000;
const INSTALL_SETTLE_MS = 1_000;
const SIGKILL_EXIT_WAIT_MS = 10_000;
const SCOPE_TAB_COUNT = 3;

// ─── copy deck (the catalog is law; expectations are RENDERED from it, never
//     hand-typed — a copy drift breaks this lane in the exact place it drifts) ──
const flattenCopy = (node: unknown, prefix: string, into: Record<string, string>): void => {
  if (typeof node !== 'object' || node === null) return;
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    const path = prefix === '' ? key : `${prefix}.${key}`;
    if (typeof value === 'string') into[path] = value;
    else flattenCopy(value, path, into);
  }
};
const catalog: Record<string, string> = {};
flattenCopy(JSON.parse(readFileSync(CATALOG_PATH, 'utf8')), '', catalog);

const renderCopy = (key: string, params: Record<string, string | number> = {}): string => {
  const template = catalog[key];
  if (template === undefined) throw new Error(`catalog drift: ${key} missing`);
  return template.replace(/\{(\w+)\}/g, (raw, name: string) =>
    params[name] === undefined ? raw : String(params[name]),
  );
};

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Exact-literal regex with parameters wildcarded (template-anchored matching). */
const templateRegex = (key: string): RegExp => {
  const template = catalog[key];
  if (template === undefined) throw new Error(`catalog drift: ${key} missing`);
  const parts = template.split(/\{(\w+)\}/g);
  const pattern = parts.map((part, i) => (i % 2 === 1 ? '.+?' : escapeRegExp(part))).join('');
  return new RegExp(`^${pattern}$`);
};

// ─── ULID minter (wire-shape only; a local copy because the surface minter's
//     ordering law is irrelevant to precondition rows) ──────────────────────────
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const TIME_CHARS = 10;
const RANDOM_CHARS = 16;
const RANDOM_BYTES = 10;
const BITS_PER_CHAR = 5;
const BASE32 = 32;

const mintUlid = (time: number): string => {
  let remaining = time;
  let stamp = '';
  for (let i = 0; i < TIME_CHARS; i += 1) {
    stamp = CROCKFORD.charAt(remaining % BASE32) + stamp;
    remaining = Math.floor(remaining / BASE32);
  }
  const bytes = randomBytes(RANDOM_BYTES);
  let bits = '';
  for (const b of bytes) bits += b.toString(2).padStart(8, '0');
  let tail = '';
  for (let i = 0; i < RANDOM_CHARS; i += 1) {
    tail += CROCKFORD.charAt(parseInt(bits.slice(i * BITS_PER_CHAR, (i + 1) * BITS_PER_CHAR), 2));
  }
  return stamp + tail;
};

// ─── chromium discovery (mirrors scripts/load-unpacked.mjs — LEDGE_CHROME, else
//     the session's Chrome-for-Testing cache under the OS tmpdir) ───────────────
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

// Unpacked-extension ids are a pure function of the extension's absolute path —
// derive one without a live SW (wake fallback needs it before any target exists).
const extensionIdFromPath = (extDir: string): string => {
  const digest = createHash('sha256').update(extDir, 'utf8').digest();
  let id = '';
  for (const byte of digest.subarray(0, 16)) {
    id += String.fromCharCode('a'.charCodeAt(0) + Math.floor(byte / 16));
    id += String.fromCharCode('a'.charCodeAt(0) + (byte % 16));
  }
  return id;
};

// ─── browser harness ───────────────────────────────────────────────────────────
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

const waitSw = async (browser: Browser, timeoutMs: number): Promise<string | null> => {
  try {
    const target = await browser.waitForTarget(
      (t) => t.type() === 'service_worker' && t.url().startsWith('chrome-extension://'),
      { timeout: timeoutMs },
    );
    return new URL(target.url()).host;
  } catch {
    return null; // SW asleep: the wake fallback opens a quiet page (kick by query)
  }
};

// Page-side types ride the bundle source verbatim (one declaration of the
// window slot — duplicated shapes collide in one compilation).
import type { LedgeE2EClient, RoundTrip, SeedSpec } from './client-entry.js';

declare global {
  interface Window {
    __ledgeE2E?: LedgeE2EClient;
  }
}

/** Attach the injected client to an already-open extension page. MV3 page CSP
 *  forbids inline <script> tags, so the bundle goes through CDP evaluate — the
 *  same privileged channel devtools uses, never the page's parser. */
const attachClient = async (page: Page): Promise<void> => {
  const source = readFileSync(CLIENT_BUNDLE, 'utf8');
  await page.evaluate(source);
  await page.waitForFunction('window.__ledgeE2E !== undefined', {
    timeout: CLIENT_BOOT_WAIT_MS,
  });
};

/** Open a quiet tab and attach the harness client (relative-time host venue). */
const openClientPage = async (browser: Browser, extensionId: string): Promise<Page> => {
  const page = await browser.newPage();
  await page.goto(`chrome-extension://${extensionId}/${QUIET_PAGE}`, { waitUntil: 'load' });
  await attachClient(page);
  return page;
};

/** SW guaranteed live: auto-start wins; else one quiet-page kick proves it. */
const ensureSw = async (browser: Browser, extensionId: string): Promise<string> => {
  const quick = await waitSw(browser, WAKE_RETRY_WAIT_MS);
  if (quick !== null) return quick;
  const page = await openClientPage(browser, extensionId);
  try {
    const afterKick = await waitSw(browser, SW_WAIT_MS);
    if (afterKick !== null) return afterKick;
    throw new Error('service worker never appeared after the wake kick');
  } finally {
    await page.close().catch(() => undefined);
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

const seedIn = (page: Page, spec: SeedSpec): Promise<string> =>
  page.evaluate((s) => {
    const api = window.__ledgeE2E;
    if (api === undefined) throw new Error('e2e client missing');
    return api.seed(s);
  }, spec);

interface BootReportView {
  bootReportId?: string;
  severity?: string;
  pending?: boolean;
  scope?: { tabsRecoverable?: number; missionsAffected?: number };
  disclosure?: readonly { token?: string; count?: number }[];
}

const asView = (raw: unknown): BootReportView =>
  typeof raw === 'object' && raw !== null ? (raw as BootReportView) : {};

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
      last = String(cause); // page vanished under us (kill) — caller decides
    }
    await sleep(POLL_STEP_MS);
  }
  throw new Error(`pollQuery(${name}) for ${what} never satisfied; last=${JSON.stringify(last)}`);
};

const quietTargets = (browser: Browser, extensionId: string) =>
  browser
    .targets()
    .filter(
      (t) => t.type() === 'page' && t.url() === `chrome-extension://${extensionId}/${QUIET_PAGE}`,
    );

const serverTargets = (browser: Browser, origin: string) =>
  browser.targets().filter((t) => t.type() === 'page' && t.url().startsWith(`${origin}/`));

const waitFor = async (
  pred: () => boolean | Promise<boolean>,
  timeoutMs: number,
  what: string,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await pred()) return;
    if (Date.now() > deadline) throw new Error(`timeout (${timeoutMs}ms) waiting for ${what}`);
    await sleep(TARGET_POLL_MS);
  }
};

const hardKill = async (browser: Browser): Promise<void> => {
  const closed = new Promise<void>((r) => {
    browser.once('close', () => r());
  });
  const proc = browser.process();
  if (proc === null || proc === undefined) {
    await browser.close().catch(() => undefined);
    return;
  }
  proc.kill('SIGKILL');
  await Promise.race([closed, sleep(SIGKILL_EXIT_WAIT_MS)]);
};

const closeBrowser = async (browser: Browser | undefined): Promise<void> => {
  if (browser === undefined) return;
  await browser.close().catch(() => undefined);
};

// ─── fixture server (the tabs the put-back must reopen) ────────────────────────
let server: Server;
let origin: string;

beforeAll(async () => {
  if (!existsSync(join(EXT_DIR, 'manifest.json')))
    throw new Error(
      `${EXT_DIR} missing — the lane needs a fresh build (pnpm test:e2e builds first)`,
    );
  if (!existsSync(CLIENT_BUNDLE))
    throw new Error(`${CLIENT_BUNDLE} missing — run pnpm build:e2e-client first`);
  server = createServer((req, res) => {
    res.statusCode = 200;
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(
      `<!doctype html><html><title>e2e ${req.url ?? ''}</title><p>seed page ${req.url ?? ''}</p></html>`,
    );
  });
  await new Promise<void>((r) => {
    server.listen(0, '127.0.0.1', () => r());
  });
  const address = server.address();
  if (address === null || typeof address === 'string')
    throw new Error('fixture server has no port');
  origin = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => {
    server.close(() => r());
  });
});

// ─── scenario A: crash-with-damage ⇒ the §14.4 card + full put-back ───────────
describe('E6-T01 real-restart e2e', () => {
  it('A: SIGKILL with a dangling intent + live scope ⇒ loss-risk card, exact copy, working put-back', async () => {
    const profile = mkdtempSync(join(tmpdir(), 'ledge-e2e-A-'));
    let browser: Browser | undefined;
    try {
      // ── boot #1 (install wake): the classifier's taxonomy is 'first-run'
      //    (NON-abnormal — no copy path by Marker law), so the view law answers
      //    null: the slot exists but stays silent. That silence IS the first-run
      //    assertion; the wire round trip also proves the SW is live.
      browser = await launch(profile);
      const extensionId = await ensureSw(browser, extensionIdFromPath(EXT_DIR));
      expect(extensionId).toBe(extensionIdFromPath(EXT_DIR));
      const page = await openClientPage(browser, extensionId);
      const firstTrip = await sendQuery(page, 'GetBootReport', {});
      expect(firstTrip.ack.outcome).toBe('ack');
      expect(firstTrip.terminal.ok).toBe(true);
      expect(firstTrip.terminal.ok ? firstTrip.terminal.value : 'err').toBeNull();
      await sleep(INSTALL_SETTLE_MS); // boot act durability margin before seed+kill

      // ── plant the crash-side world (the harness's ONLY authority act):
      //    one universal-kind dangling intent (no lawful abort row ⇒ reconciler
      //    defers ⇒ loss-risk) + one live mission with three live tab rows
      //    (the put-back scope the card must count — scope ≡ put-back set).
      const seededAt = Date.now();
      const missionId = mintUlid(seededAt);
      const tabIds = [0, 1, 2].map((i) => mintUlid(seededAt + i + 1));
      const urls = tabIds.map((_, i) => `${origin}/p${i + 1}`);
      await seedIn(page, {
        dbName: IDB_NAME,
        intents: [
          {
            intentId: mintUlid(seededAt + 9),
            cid: mintUlid(seededAt + 10),
            kind: 'RescueScanNow',
            scope: {},
            state: 'intent',
            issuedAt: 1,
            retryCount: 0,
          },
        ],
        tabs: tabIds.map((ledgeTabId, i) => ({
          ledgeTabId,
          url: urls[i],
          title: `e2e p${i + 1}`,
          domain: '127.0.0.1',
          missionId,
          state: 'live',
          firstSeenAt: seededAt,
          lastActiveAt: seededAt,
        })),
        missions: [
          {
            missionId,
            name: 'W7 E2E mission',
            namedBy: 'user',
            state: 'live',
            concluded: false,
            tabIds,
            createdAt: seededAt,
            lastActiveAt: seededAt,
          },
        ],
      });

      // ── REAL browser death (no shutdown ceremony, no marker disarm).
      await hardKill(browser);
      browser = undefined;

      // ── relaunch: marker classify 'crashed' against the real chrome.storage
      //    areas; reconcile defers the seeded intent ⇒ loss-risk ⇒ the §14.4
      //    gate opens the card venue (auto-start SW) or focuses the wake page.
      browser = await launch(profile);
      const autoStarted = (await waitSw(browser, WAKE_RETRY_WAIT_MS)) !== null;
      console.info(`[e2e:A] relaunch: SW auto-started=${autoStarted}`);
      await ensureSw(browser, extensionId);

      // The card venue: a quiet tab that arrives/shows the recovery card. When
      // the SW auto-started, the venue itself created the tab; otherwise the
      // wake tab becomes the venue. Either way the §14.4 product law under
      // test is card-present-with-exact-copy, so assert on the card venue.
      await waitFor(
        () => quietTargets(browser as Browser, extensionId).length > 0,
        CARD_WAIT_MS,
        'the recovery card quiet venue',
      );
      const cardTarget = quietTargets(browser, extensionId)[0];
      if (cardTarget === undefined) throw new Error('card venue vanished');
      const cardPage = await cardTarget.page();
      if (cardPage === null) throw new Error('card venue not attachable');
      await cardPage.waitForSelector(
        '.recovery-card[data-card="recovery"][data-severity="loss-risk"]',
        {
          timeout: CARD_WAIT_MS,
        },
      );

      // ── exact catalog copy (template-anchored; only params wildcarded).
      const lines = await cardPage.evaluate(() => {
        const read = (sel: string): string => document.querySelector(sel)?.textContent ?? '';
        return {
          title: read('[data-line="recovery-title"]'),
          scope: read('[data-line="recovery-scope"]'),
        };
      });
      expect(lines.title).toMatch(templateRegex('msg.recovery.crashed'));
      expect(lines.scope).toBe(
        renderCopy('msg.recovery.scope', { tabs: SCOPE_TAB_COUNT, missions: 1 }),
      );

      // ── disclosure notes (review-first toggle): EXACTLY the deferred(1) note.
      //    E3-T03: the sessions cross-check is LIVE against a healthy browser, so
      //    'applied' leaves no crosscheck-degraded note; gaps are empty, so no
      //    marker-gap note — the honest inventory of THIS damage class is the
      //    one kept-place intent, rendered verbatim from the catalog.
      await cardPage.click('.recovery-card [data-action="review-first"]');
      const notes = await cardPage.evaluate(() =>
        [...document.querySelectorAll('[data-panel="recovery-review"] li')].map((li) => ({
          line: li.getAttribute('data-line') ?? '',
          text: li.textContent ?? '',
        })),
      );
      const byLine = new Map(notes.map((n) => [n.line, n.text]));
      expect(notes.length).toBe(1);
      expect(byLine.get('recovery-note-deferred')).toBe(
        renderCopy('msg.recovery.note-deferred', { count: 1 }),
      );

      // ── put-back: the W7 act itself. Three REAL browser tabs must return
      //    with exactly the seeded URLs; the card resolves; the slot settles.
      await cardPage.click('.recovery-card [data-action="put-back"]');
      await waitFor(
        () => serverTargets(browser as Browser, origin).length === SCOPE_TAB_COUNT,
        RESOLVED_WAIT_MS,
        'three reopened browser tabs',
      );
      const reopened = serverTargets(browser, origin)
        .map((t) => t.url())
        .sort();
      expect(reopened).toEqual([...urls].sort());

      await cardPage.waitForSelector('[data-card="recovery-resolved"]', {
        timeout: RESOLVED_WAIT_MS,
      });
      const resolvedText = await cardPage.evaluate(
        () => document.querySelector('[data-card="recovery-resolved"]')?.textContent ?? '',
      );
      expect(resolvedText).toBe(renderCopy('msg.recovery.restored'));

      // ── settle law: the incident retired (card hides on every later read).
      await attachClient(cardPage);
      const settledRaw = await sendQuery(cardPage, 'GetBootReport', {});
      expect(settledRaw.ack.outcome).toBe('ack');
      if (!settledRaw.terminal.ok) throw new Error('settle read failed');
      const settled = asView(settledRaw.terminal.value);
      expect(settled.severity).toBe('loss-risk');
      expect(settled.pending).toBe(false);
    } finally {
      await closeBrowser(browser);
      rmSync(profile, { recursive: true, force: true });
    }
  });

  // ─── scenario B: graceful close ⇒ clean-abnormal announce, NO card ──────────
  it('B: graceful browser close ⇒ clean-abnormal announce, §14.4 negative gate holds (no card)', async () => {
    const profile = mkdtempSync(join(tmpdir(), 'ledge-e2e-B-'));
    let browser: Browser | undefined;
    try {
      browser = await launch(profile);
      const extensionId = await ensureSw(browser, extensionIdFromPath(EXT_DIR));
      // First-run taxonomy (install wake): silent — the view answers null.
      const firstTrip = await (async () => {
        const p = await openClientPage(browser, extensionId);
        const t = await sendQuery(p, 'GetBootReport', {});
        await p.close();
        return t;
      })();
      expect(firstTrip.ack.outcome).toBe('ack');
      expect(firstTrip.terminal.ok).toBe(true);
      expect(firstTrip.terminal.ok ? firstTrip.terminal.value : 'err').toBeNull();
      await sleep(INSTALL_SETTLE_MS);

      // Graceful shutdown: the browser closes through its ceremony; the next
      // wake still reads the marker's all-absent proof (alive bit gone) and the
      // conservative compass says 'crashed' — but nothing is damaged.
      await closeBrowser(browser);
      browser = undefined;

      browser = await launch(profile);
      await ensureSw(browser, extensionId);
      const page2 = await openClientPage(browser, extensionId);
      // Post-restart classify: graceful close still proves alive-absent, the
      // conservative compass says 'crashed' (abnormal ⇒ announced) but nothing
      // is damaged ⇒ clean-abnormal severity — the FIRST announced incident.
      const secondRaw = await pollQuery(
        page2,
        'GetBootReport',
        {},
        (v) => v !== null,
        'post-restart incident slot',
      );
      const second = asView(secondRaw);
      expect(second.severity).toBe('clean-abnormal');
      expect(second.pending).toBe(false);

      // The negative gate: observation window, no card venue, no card DOM.
      await sleep(NEGATIVE_OBSERVE_MS);
      const venueTabs = quietTargets(browser, extensionId).filter((t) => t.url() !== page2.url());
      expect(venueTabs.length).toBe(0);
      const cardNode = await page2.$('.recovery-card[data-card="recovery"]');
      expect(cardNode).toBeNull();
    } finally {
      await closeBrowser(browser);
      rmSync(profile, { recursive: true, force: true });
    }
  });
});
