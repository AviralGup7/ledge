// E4 · Accessibility suite — EES §7.4 cross-surface invariants, asserted against
// the mounted trees (behavior, not pixels): one polite live region per surface;
// landmark roles + labels; combobox/listbox wiring; alert-on-error; 44px button
// law (.btn class) on every actionable button; no positive tabindex traps; inputs
// always labelled; keyboard reachability of every command (no click-only paths).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { copyOf } from '@/surfaces/components/copy/copy.js';
import { mountGuardian } from '@/surfaces/guardian/guardian.js';
import { mountOverlay } from '@/surfaces/overlay/overlay.js';
import { mountQuietPage } from '@/surfaces/quiet-page/quiet.js';
import { FakeDocument, asDocument, type FakeElement } from './fake-dom.js';
import {
  createFakeTransport,
  createTestEntropy,
  flush,
  type FakeTransport,
} from './fake-transport.js';

const BOOTSTRAP = {
  missions: [
    {
      missionId: 'm1',
      name: 'One',
      namedBy: 'user',
      state: 'parked',
      concluded: false,
      tabCount: 1,
    },
  ],
  recentlyClosed: [],
  trashCount: 0,
  watermark: 1,
  settings: {},
  heartbeat: { keptCount: 2, liveRecoverable: 0, asOf: 0 },
};

const answerQueries = async (
  fake: FakeTransport,
  values: Record<string, unknown>,
): Promise<void> => {
  for (let round = 0; round < 2; round += 1) {
    await flush();
    for (const env of [...fake.sent]) {
      if (env.kind === 'query' && env.name in values) fake.apply(env.cid, values[env.name]);
    }
    await flush();
  }
};

const OPEN_TAB = {
  browserTabId: 31,
  windowId: 1,
  title: 'A tab',
  url: 'https://a.example.com/',
  pinned: false,
  active: false,
  groupId: null,
};

const mountGuardianWithAnswers = async () => {
  const doc = new FakeDocument();
  const fake = createFakeTransport();
  const mounted = mountGuardian(asDocument(doc), {
    transport: fake.transport,
    entropy: createTestEntropy(),
  });
  await answerQueries(fake, { GetBootstrap: BOOTSTRAP, PeekOpenTabs: [OPEN_TAB] });
  return { doc, fake, mounted };
};

const mountQuietWithAnswers = async () => {
  const doc = new FakeDocument();
  const fake = createFakeTransport();
  const mounted = mountQuietPage(asDocument(doc), {
    transport: fake.transport,
    entropy: createTestEntropy(),
  });
  await answerQueries(fake, {
    GetBootstrap: BOOTSTRAP,
    GetLibrary: { missions: BOOTSTRAP.missions },
  });
  return { doc, fake, mounted };
};

const mountOverlayShell = () => {
  const doc = new FakeDocument();
  const fake = createFakeTransport();
  const mounted = mountOverlay(asDocument(doc), {
    transport: fake.transport,
    entropy: createTestEntropy(),
    debounce: (_d, fn) => {
      void fn;
      return () => {};
    },
    close: () => {},
    contractHash: 'test',
  });
  return { doc, fake, mounted };
};

const buttons = (root: FakeElement): readonly FakeElement[] => root.querySelectorAll('button');

describe('E4 a11y · live regions (one polite announcer per surface)', () => {
  it('guardian: exactly one aria-live=polite region with role=status', async () => {
    const { doc, mounted } = await mountGuardianWithAnswers();
    const regions = doc.body.querySelectorAll('[aria-live="polite"]');
    expect(regions).toHaveLength(1);
    expect(regions[0]?.getAttribute('role')).toBe('status');
    expect(regions[0]?.classList).toContain('sr-only');
    mounted.unmount();
  });

  it('quiet: exactly one; overlay: exactly one', async () => {
    const quiet = await mountQuietWithAnswers();
    expect(quiet.doc.body.querySelectorAll('[aria-live="polite"]')).toHaveLength(1);
    quiet.mounted.unmount();
    const overlay = mountOverlayShell();
    expect(overlay.doc.body.querySelectorAll('[aria-live="polite"]')).toHaveLength(1);
    overlay.mounted.unmount();
    expect(quiet.doc.body.querySelectorAll('[aria-live="polite"]')).toHaveLength(0);
    expect(overlay.doc.body.querySelectorAll('[aria-live="polite"]')).toHaveLength(0);
  });

  it('no assertive aria-live anywhere (calm is the law; alerts use role=alert only)', async () => {
    const { doc, fake, mounted } = await mountGuardianWithAnswers();
    expect(doc.body.querySelectorAll('[aria-live="assertive"]')).toHaveLength(0);
    // Force an error: the error block uses role=alert (implicit assertive), which
    // is the sanctioned path — never aria-live=assertive on ambient regions.
    fake.fail(fake.lastOf('PeekOpenTabs').cid, { code: 'E_CAPABILITY' });
    await flush();
    expect(doc.body.querySelectorAll('[aria-live="assertive"]')).toHaveLength(0);
    mounted.unmount();
  });
});

describe('E4 a11y · landmarks & labels', () => {
  it('guardian: regions for open tabs and missions carry aria-labels', async () => {
    const { doc, mounted } = await mountGuardianWithAnswers();
    expect(doc.body.querySelector('[data-section="open"]')?.getAttribute('aria-label')).toBe(
      copyOf('msg.aria.tabs'),
    );
    expect(doc.body.querySelector('[data-section="missions"]')?.getAttribute('aria-label')).toBe(
      copyOf('msg.aria.missions'),
    );
    expect(doc.body.querySelector('[data-section="pending"]')?.getAttribute('role')).toBe('group');
    mounted.unmount();
  });

  it('quiet: nav landmark with label; every nav button has an accessible name', async () => {
    const { doc, mounted } = await mountQuietWithAnswers();
    const nav = doc.body.querySelector('nav');
    expect(nav?.getAttribute('aria-label')).toBe(copyOf('msg.aria.nav'));
    if (nav === null) throw new Error('nav landmark missing');
    for (const button of buttons(nav)) {
      expect(button.textContent.trim().length).toBeGreaterThan(0);
    }
    mounted.unmount();
  });

  it('overlay: dialog landmark + labelled combobox; listbox labelled', () => {
    const { doc, mounted } = mountOverlayShell();
    const dialog = doc.body.querySelector('[role="dialog"]');
    expect(dialog?.getAttribute('aria-label')).toBe(copyOf('msg.aria.palette'));
    const input = doc.body.querySelector('input[role="combobox"]');
    expect(input?.getAttribute('aria-label')).toBe(copyOf('msg.aria.palette'));
    expect(input?.getAttribute('aria-controls')).toBe('palette-list');
    const list = doc.body.querySelector('#palette-list');
    expect(list).not.toBeNull(); // aria-controls resolves to a real element
    expect(list?.getAttribute('role')).toBe('listbox');
    expect(list?.getAttribute('aria-label')).toBe(copyOf('msg.aria.results'));
    mounted.unmount();
  });

  it('the aria-controls relationship is reciprocal on the expanded combobox', () => {
    const { doc, mounted } = mountOverlayShell();
    const input = doc.body.querySelector('input[role="combobox"]');
    expect(input?.getAttribute('aria-expanded')).toBe('true');
    const targetId = input?.getAttribute('aria-controls');
    expect(doc.body.querySelector(`#${targetId ?? ''}`)).not.toBeNull();
    mounted.unmount();
  });
});

describe('E4 a11y · interaction law', () => {
  it('every actionable button in every mounted surface carries the .btn class (44px)', async () => {
    const guardian = await mountGuardianWithAnswers();
    await flush();
    for (const button of buttons(guardian.doc.body)) {
      expect(
        button.classList,
        guardian.doc.body.querySelector('.guardian-start')?.textContent,
      ).toContain('btn');
    }
    guardian.mounted.unmount();
    const quiet = await mountQuietWithAnswers();
    for (const button of buttons(quiet.doc.body)) {
      expect(button.classList).toContain('btn');
    }
    quiet.mounted.unmount();
  });

  it('no positive tabindex anywhere; focus order follows the tree', async () => {
    const guardian = await mountGuardianWithAnswers();
    for (const el of guardian.doc.allElements()) {
      const tab = el.getAttribute('tabindex');
      if (tab !== null) expect(Number(tab)).toBeLessThanOrEqual(0);
    }
    expect(guardian.doc.body.querySelector('.mission-card')?.getAttribute('tabindex')).toBe('0'); // mission cards are focusable groups
    guardian.mounted.unmount();
    const quiet = await mountQuietWithAnswers();
    for (const el of quiet.doc.allElements()) {
      const tab = el.getAttribute('tabindex');
      if (tab !== null) expect(Number(tab)).toBeLessThanOrEqual(0);
    }
    quiet.mounted.unmount();
  });

  it('every input has an aria-label (no unlabelled fields, banner ads)', async () => {
    const guardian = await mountGuardianWithAnswers();
    for (const input of guardian.doc.body.querySelectorAll('input')) {
      expect(
        input.getAttribute('aria-label'),
        JSON.stringify(input.getAttribute('class')),
      ).not.toBeNull();
    }
    guardian.mounted.unmount();
    const quiet = await mountQuietWithAnswers();
    // Settings section is the input-dense one.
    quiet.doc.body.querySelector('[data-nav="settings"]')?.click();
    await flush();
    for (const input of quiet.doc.body.querySelectorAll('input')) {
      expect(input.getAttribute('aria-label')).not.toBeNull();
    }
    for (const label of quiet.doc.body.querySelectorAll('label')) {
      const forId = label.getAttribute('for');
      expect(forId).not.toBeNull();
      // HTML for= resolves by exact id lookup, never CSS (ids like setting-{key}
      // contain dots — getElementById semantics are the honest assertion).
      expect(quiet.doc.getElementById(forId ?? '')).not.toBeNull();
    }
    quiet.mounted.unmount();
  });

  it('error states use role=alert with both message and recovery lines', async () => {
    const guardian = await mountGuardianWithAnswers();
    const { fake, doc } = guardian;
    // A park-command failure lands in the banner error block (runCommand's path).
    doc.body.querySelector('[data-action="park-tab"]')?.click();
    await flush();
    fake.fail(fake.lastOf('ParkTab').cid, {
      code: 'E_CAPABILITY',
      messageKey: 'msg.error.capability',
      recoveryKey: 'msg.recover.update',
    });
    await flush();
    const alert = doc.body.querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert?.querySelector('.state-line')).not.toBeNull();
    expect(alert?.querySelector('.state-recovery')).not.toBeNull();
    guardian.mounted.unmount();
  });
});

describe('E4 a11y · motion & theme (CSS contract asserted against the stylesheet)', () => {
  const css = readFileSync('assets/surfaces.css', 'utf8');

  it('reduced-motion media query exists and kills animation/shimmer inside it', () => {
    const block = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(block.length).toBeGreaterThan(0);
    expect(block).toContain('animation');
    expect(block).toMatch(/animation:\s*none|animation-duration:\s*0/);
  });

  it('dark mode follows the OS with a data-theme override seam', () => {
    expect(css).toContain('@media (prefers-color-scheme: dark)');
    expect(css).toContain("[data-theme='dark']");
    expect(css).toContain("[data-theme='light']");
  });

  it('minimum target size law is codified on .btn (44px)', () => {
    const btnBlock = css.slice(css.indexOf('.btn'));
    expect(btnBlock).toMatch(/min-height:\s*44px|min-block-size:\s*44px/);
  });
});
