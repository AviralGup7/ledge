// E7-T03 · §7.4 platform-mode + zoom law, asserted against the stylesheet and
// the entrypoint shells (behavior of CSS/markup, not pixels): high-contrast
// mode (Spec §4.5 P0) thickens borders/focus; forced-colors defers to the
// system palette; zoom integrity is the rem law (no px layout traps); focus is
// always visible; shells carry language, title, viewport, and a no-JS fallback.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const CSS = readFileSync('assets/surfaces.css', 'utf8');
/** User-visible surfaces: every §7.4 WCAG 3.1.x document law applies. */
const UI_SHELLS = [
  'entrypoints/guardian/index.html',
  'entrypoints/overlay/index.html',
  'entrypoints/quiet-page/index.html',
] as const;
/** The workroom is an offscreen document — never displayed (no viewport/scroll
 *  semantics, and <noscript> can never render). Language + title are declared
 *  anyway: document-language honesty is free and screen-reader crawls read it. */
const HIDDEN_SHELLS = ['entrypoints/workroom/index.html'] as const;

/** Slice from `mark` to the next top-level block opener after it. */
const blockAfter = (mark: string): string => {
  const at = CSS.indexOf(mark);
  if (at < 0) return '';
  // One media block is ~a few dozen lines; a generous window is honest.
  const WINDOW = 400;
  return CSS.slice(at, at + WINDOW);
};

describe('E7-T03 a11y · high-contrast + forced-colors modes (Spec §4.5 P0)', () => {
  it('prefers-contrast: more strengthens borders and the focus ring', () => {
    expect(CSS).toContain('@media (prefers-contrast: more)');
    const block = blockAfter('@media (prefers-contrast: more)');
    expect(block).toMatch(/border-width:\s*2px/);
    expect(block).toMatch(/outline-width:\s*3px/);
  });

  it('forced-colors defers to the system palette (never paints over it)', () => {
    expect(CSS).toContain('@media (forced-colors: active)');
    const block = blockAfter('@media (forced-colors: active)');
    expect(block).toContain('ButtonBorder');
    expect(block).toContain('Highlight');
    // The pressed state stays distinguishable under forced colors.
    expect(block).toContain("aria-pressed='true'");
  });

  it('the two mode blocks follow the reduce-motion block (mode family is one unit)', () => {
    const motion = CSS.indexOf('@media (prefers-reduced-motion: reduce)');
    const contrast = CSS.indexOf('@media (prefers-contrast: more)');
    const forced = CSS.indexOf('@media (forced-colors: active)');
    expect(motion).toBeGreaterThanOrEqual(0);
    expect(contrast).toBeGreaterThan(motion);
    expect(forced).toBeGreaterThan(contrast);
  });
});

describe('E7-T03 a11y · 200% zoom integrity (the rem law)', () => {
  it('no px layout traps: max-widths are rem, wide fixed widths are absent', () => {
    expect(CSS).not.toMatch(/max-width:\s*\d+(\.\d+)?px/);
    expect(CSS).not.toMatch(/(?<![\w-])width:\s*\d{3,}(\.\d+)?px/);
    expect(CSS).toMatch(/max-width:\s*\d+(\.\d+)?rem/);
  });

  it('text scales: at most one absolute font-size token (the root base)', () => {
    const absoluteFonts = CSS.match(/font-size:\s*\d+(\.\d+)?px/g) ?? [];
    expect(absoluteFonts.length).toBeLessThanOrEqual(1);
  });

  it('focus is always visible (shared-sheet :focus-visible ring)', () => {
    expect(CSS).toContain(':focus-visible');
    const block = blockAfter(':focus-visible');
    expect(block).toContain('outline');
  });
});

describe('E7-T03 a11y · surface shells (language, title, viewport, fallback)', () => {
  for (const shell of UI_SHELLS) {
    it(`${shell}: lang + title + viewport + noscript`, () => {
      const html = readFileSync(shell, 'utf8');
      expect(html).toContain('<html lang="en">');
      expect(html).toMatch(/<title>[^<]+<\/title>/);
      expect(html).toContain('name="viewport"');
      // The tag may be line-wrapped by prettier — match the opener, not a literal.
      expect(html).toMatch(/<noscript[\s>]/);
    });
  }
  for (const shell of HIDDEN_SHELLS) {
    it(`${shell}: never displayed, but language + title are still declared`, () => {
      const html = readFileSync(shell, 'utf8');
      expect(html).toContain('<html lang="en">');
      expect(html).toMatch(/<title>[^<]+<\/title>/);
    });
  }
});
