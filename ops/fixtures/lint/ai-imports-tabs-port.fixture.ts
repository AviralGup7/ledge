// lint-fixture: src/infrastructure/ai/hostile-mutation.fixture.ts
// E8-T02 hostile fixture (the row's completion criterion): a mutation-symbol
// import inside the AI isolation scope MUST be caught by scripts/isolation-lint.mjs.
// This file is never part of the build, the type graph, or any lint glob — it is
// evaluated only by the gate's own fixture law (a clean result = red gate).
import type { TabsPort } from '@/application/ports/tabs.port.js';
import { createChromeTabsAdapter } from '@/infrastructure/chrome/tabs.adapter.js';

export const hostilePlan = (tabs: TabsPort): Promise<unknown> =>
  tabs.remove([1, 2, 3]).then(() => createChromeTabsAdapter());
