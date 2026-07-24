// Build + manifest configuration (ADR-036). MV3-first; service worker ships as ESM ("type":"module").
// SECURITY: the CSP wasm exception below is load-bearing documentation — ADR-040.
import { defineConfig } from 'wxt';

export default defineConfig({
  srcDir: '.',
  publicDir: 'assets',
  manifest: {
    name: 'Ledge — Tab & Session Manager',
    short_name: 'Ledge',
    description:
      'Never lose a thought. AI-organized tab & session manager: park without loss, resume with context, find anything. Local-first and private.',
    // ADR-022 — this array is a trust artifact. Adding an entry requires an ADR + manifest diff sign-off.
    // Justifications: docs/permissions.md.
    permissions: [
      'tabs',              // see and keep tab titles/addresses so they can be restored
      'tabGroups',         // keep your group structure
      'sessions',          // recover after a crash
      'storage',           // your archive lives on your device
      'unlimitedStorage',  // so your archive never runs out of space
      'alarms',            // maintenance on schedule
      'offscreen',         // heavy lifting without slowing your browsing
      'favicon',           // show site icons
      'contextMenus',      // park from right-click
    ],
    // FORBIDDEN BY LAW (S-06 / ADR-022): notifications, downloads, cookies, history, host permissions, scripting.
    optional_permissions: [],
    action: { default_title: 'Ledge — 0 tabs safe' },
    content_security_policy: {
      // 'wasm-unsafe-eval' exists ONLY for on-device AI (infrastructure/ai/providers/ondevice).
      // Reviewed at every CSP-relevant Chrome change (ADR-040). Never widen.
      extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'none'; base-uri 'none'",
    },
    background: { type: 'module' },
  },
  alias: {
    '@/shared-kernel': 'src/shared-kernel',
    '@/domain': 'src/domain',
    '@/application': 'src/application',
    '@/infrastructure': 'src/infrastructure',
    '@/surfaces': 'src/surfaces',
    '@/roots': 'src/roots',
    '@/testing': 'ops/tests',
  },
});
