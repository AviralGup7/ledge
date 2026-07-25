// E3-T01 · fake-chrome parity sanity — the contract suites trust the fake, so the
// fake's chrome-parity semantics are themselves pinned here (cascade shapes, sentinel
// values, lastError strings, activation-after-remove behaviour).
import { describe, expect, it } from 'vitest';
import { createFakeChrome } from './fake-chrome.js';

describe('fake-chrome — chrome-parity sanity', () => {
  it('rejects with the exact lastError strings adapters map on', async () => {
    const fake = createFakeChrome();
    await expect(fake.tabs.get(-42)).rejects.toThrow('No tab with id: -42');
    await expect(fake.windows.update(-43, { focused: true })).rejects.toThrow(
      'No window with id: -43',
    );
  });

  it('window close cascades tabs.onRemoved{isWindowClosing:true} then windows.onRemoved', async () => {
    const fake = createFakeChrome();
    const w = await fake.windows.create({ url: ['https://x/1', 'https://x/2'], focused: false });
    const seen: string[] = [];
    fake.tabs.onRemoved.addListener((id, info) => {
      seen.push(`tab:${id}:${String(info.isWindowClosing)}`);
    });
    fake.windows.onRemoved.addListener((id) => {
      seen.push(`window:${id}`);
    });
    await fake.windows.remove(w.id ?? -1);
    expect(seen.length).toBe(3);
    expect(seen[0]?.startsWith('tab:')).toBe(true);
    expect(seen[0]?.endsWith(':true')).toBe(true);
    expect(seen[2]).toBe(`window:${w.id ?? -1}`);
  });

  it('removing the active tab activates a neighbour (chrome behaviour)', async () => {
    const fake = createFakeChrome();
    const a = await fake.tabs.create({ url: 'https://n/1', active: false });
    const b = await fake.tabs.create({ url: 'https://n/2', active: true });
    const activated: number[] = [];
    fake.tabs.onActivated.addListener((info) => {
      activated.push(info.tabId);
    });
    await fake.tabs.remove(b.id ?? -1);
    expect(activated).toEqual([a.id ?? -1]);
  });

  it('closing the focused window fires onFocusChanged(-1) (WINDOW_ID_NONE semantics)', async () => {
    const fake = createFakeChrome();
    const seen: number[] = [];
    fake.windows.onFocusChanged.addListener((id) => {
      seen.push(id);
    });
    const first = fake.hooks.focusedWindowId();
    await fake.windows.remove(first);
    expect(seen).toEqual([-1]);
  });

  it('one-shot sabotage fires once and only once', async () => {
    const fake = createFakeChrome();
    fake.hooks.sabotageNext(new Error('revoked'));
    await expect(fake.tabs.query({})).rejects.toThrow('revoked');
    await expect(fake.tabs.query({})).resolves.toEqual([]);
  });

  it('move across windows produces attached (reindexing both windows)', async () => {
    const fake = createFakeChrome();
    const w2 = await fake.windows.create({ url: [], focused: false });
    const t = await fake.tabs.create({ url: 'https://mv/1', active: false });
    const events: string[] = [];
    fake.tabs.onAttached.addListener((id, info) => {
      events.push(`${id}→w${info.newWindowId}@${info.newPosition}`);
    });
    await fake.tabs.move(t.id ?? -1, { windowId: w2.id ?? -1, index: 0 });
    expect(events).toEqual([`${t.id ?? -1}→w${w2.id ?? -1}@0`]);
    expect(fake.hooks.rawTab(t.id ?? -1)?.windowId).toBe(w2.id ?? -1);
    expect(fake.hooks.rawTab(t.id ?? -1)?.index).toBe(0);
  });
});
