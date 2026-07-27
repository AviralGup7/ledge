// E7-T03 · §7.4 row 3 — the heartbeat reaches screen readers politely (Spec
// §5.13: "heartbeat uses polite live-region semantics"). role=status IS the
// implicit polite live region; text updates are the announcements; the zero
// state is honest copy, never a fake "all safe".
import { describe, expect, it } from 'vitest';
import { copyOf } from '@/surfaces/components/copy/copy.js';
import { createHeartbeatPill } from '@/surfaces/components/widgets/heartbeat.js';
import { FakeDocument, asDocument } from '../unit/surfaces/fake-dom.js';

const pillLine = (root: { textContent: string | null }): string => root.textContent?.trim() ?? '';

describe('E7-T03 a11y · heartbeat announcement contract', () => {
  it('role=status + a catalog aria-label (the polite-region posture)', () => {
    const doc = new FakeDocument();
    const pill = createHeartbeatPill(asDocument(doc));
    expect(pill.el.getAttribute('role')).toBe('status');
    expect(pill.el.getAttribute('aria-label')).toBe(copyOf('msg.aria.heartbeat'));
    expect(pill.el.getAttribute('aria-live')).not.toBe('assertive');
  });

  it('zero tabs is the honest quiet state (never a fake safe)', () => {
    const doc = new FakeDocument();
    const pill = createHeartbeatPill(asDocument(doc));
    pill.update({ keptCount: 0 });
    expect(pillLine(pill.el)).toBe(copyOf('msg.heartbeat.quiet'));
  });

  it('updates announce kept counts; returning to empty re-announces quiet', () => {
    const doc = new FakeDocument();
    const pill = createHeartbeatPill(asDocument(doc));
    const KEPT = 2;
    pill.update({ keptCount: KEPT });
    expect(pillLine(pill.el)).toBe(copyOf('msg.heartbeat.safe', { count: KEPT }));
    pill.update({ keptCount: 0 });
    expect(pillLine(pill.el)).toBe(copyOf('msg.heartbeat.quiet'));
    // The label posture survives every update (announcements are content-only).
    expect(pill.el.getAttribute('role')).toBe('status');
    expect(pill.el.getAttribute('aria-label')).toBe(copyOf('msg.aria.heartbeat'));
  });

  it('aria-label never carries the volatile count (labels are stable)', () => {
    const doc = new FakeDocument();
    const pill = createHeartbeatPill(asDocument(doc));
    const KEPT = 7;
    pill.update({ keptCount: KEPT });
    expect(pill.el.getAttribute('aria-label')).toBe(copyOf('msg.aria.heartbeat'));
    expect(pillLine(pill.el)).toBe(copyOf('msg.heartbeat.safe', { count: KEPT }));
  });
});
