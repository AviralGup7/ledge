// Public surface of infrastructure/chrome (E3-T01 · A-02 containment boundary).
// The ONLY modules in the repo allowed to reference the ambient `chrome` global
// (eslint-scoped). Consumers bind ports; nobody imports api-surface internals but
// adapters, fakes, and the contract suites.
export { createChromeTabsAdapter } from './tabs.adapter.js';
export type { TabsAdapterDeps } from './tabs.adapter.js';
export { createChromeWindowsAdapter } from './windows.adapter.js';
export type { WindowsAdapterDeps } from './windows.adapter.js';
export { createChromeStorageAreaAdapter } from './storage-area.adapter.js';
export type { StorageAreaAdapterDeps } from './storage-area.adapter.js';
export { createChromeSessionsAdapter, RECENTLY_CLOSED_CAP } from './sessions.adapter.js';
export type { SessionsAdapterDeps } from './sessions.adapter.js';
export { createChromeOffscreenAdapter, OFFSCREEN_REASON_TABLE } from './offscreen.adapter.js';
export type { OffscreenAdapterDeps } from './offscreen.adapter.js';
export type {
  ChromeTabLike,
  ChromeTabChangeInfo,
  ChromeTabsApi,
  ChromeWindowLike,
  ChromeWindowsApi,
  ChromeStorageAreaLike,
  ChromeStorageApi,
  ChromeSessionLike,
  ChromeSessionTabLike,
  ChromeSessionWindowLike,
  ChromeSessionsApi,
  ChromeOffscreenApi,
  ChromeOffscreenCreateParameters,
} from './api-surface.js';
