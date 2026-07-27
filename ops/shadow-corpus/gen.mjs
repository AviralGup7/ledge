#!/usr/bin/env node
// E8-T03 · shadow-corpus generator (ops/shadow-corpus/missions.json).
// TOTALLY seeded (mulberry32, no Date/Math.random) — regeneration is
// byte-identical; ops/shadow-eval/run.mjs byte-compares before judging, so the
// corpus the gate judges IS the corpus in version control (same derivation-pin
// law as check:ondevice-model).
//
// TEMPLATE LAW: every title template is authored to fire EXACTLY the lexicon
// frames its `fires` tag declares (full-word boundary law — "components" never
// fires "component", "subledger" never fires "ledger"). The shadow eval RUNS
// the shipped machine against these rows and fails if machine-top fires escape
// the declared union — authoring debt and machine drift both break the build.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = join(HERE, 'missions.json');

export const CORPUS_SCHEMA = 'shadow-corpus-v1';
export const CORPUS_SEED = 0x1ed9e;
const ROWS_PER_CLUSTER = 25;
const BASE_WALL = 1_786_300_000_000; // ~2026-07 — takenAt anchor

const mulberry32 = (seed) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const makePick = (rand) => (arr) => arr[Math.floor(rand() * arr.length)];
const makeInts = (rand) => (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));

/** Shuffle a copy of `arr` with the seeded stream (Fisher–Yates). */
const shuffle = (rand, arr) => {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    const t = out[i];
    out[i] = out[j];
    out[j] = t;
  }
  return out;
};

// ── Chaff register (fires audited; mixed rows cap one title per chaff frame) ─
const CHAFF = [
  { t: 'Gmail inbox — promotions tab', fires: ['email'], domain: 'mail.example' },
  { t: 'Your weekly newsletter digest', fires: ['email'], domain: 'mail.example' },
  { t: 'Calendar — the week ahead', fires: ['calendar'], domain: 'cal.example' },
  { t: 'Meeting invite: thursday sync', fires: ['calendar'], domain: 'cal.example' },
  { t: 'slack · general channel chatter', fires: ['chat'], domain: 'chat.example' },
  { t: 'discord — the group chat', fires: ['chat'], domain: 'chat.example' },
  { t: 'Your cart is waiting (3 items)', fires: ['shopping'], domain: 'shop.example' },
  { t: 'checkout — order summary', fires: ['shopping'], domain: 'shop.example' },
  { t: 'breaking news — morning briefing', fires: ['news'], domain: 'news.example' },
  { t: 'Top headline roundup for today', fires: ['news'], domain: 'news.example' },
];

// ── Signal clusters: inert coinage slots keep the boundary law honest ────────
const CLUSTERS = {
  github: {
    domain: 'github.example',
    slots: { repo: ['kestrel', 'marlow', 'brindle', 'corvid'] },
    pool: [
      { t: 'Merged pull request on {repo}', fires: ['github'] },
      { t: 'Reverting a bad commit in {repo}', fires: ['github'] },
      { t: 'The {repo} diff view, unified vs split', fires: ['github'] },
      { t: 'github mobile — notifications center', fires: ['github'] },
      { t: 'The {repo} pull request checklist', fires: ['github'] },
      { t: 'Squash and merged etiquette for {repo}', fires: ['github'] },
      { t: 'How {repo} structures every commit', fires: ['github'] },
      { t: 'Reviewing the {repo} diff thread', fires: ['github'] },
      { t: '{repo} — commit signing for new joiners', fires: ['github'] },
      { t: 'Why the {repo} pull request queue works', fires: ['github'] },
    ],
  },
  react: {
    domain: 'reactjs.example',
    slots: { pkg: ['quillon', 'vespra', 'norwick'] },
    pool: [
      { t: 'React 19 features — what changed', fires: ['react'] },
      { t: 'Every {pkg} component re-renders twice', fires: ['react'] },
      { t: 'useEffect hooks under stress', fires: ['react'] },
      { t: 'JSX pitfalls worth memorizing', fires: ['react'] },
      { t: 'The react reconciliation loop', fires: ['react'] },
      { t: 'next js navigation — app router notes', fires: ['react'] },
      { t: 'Why nextjs chose partial prendering', fires: ['react'] },
      { t: 'The hooks dependency-array, demystified', fires: ['react'] },
      { t: 'From classes to hooks: the {pkg} migration', fires: ['react'] },
      { t: 'Thinking in react — composition notes', fires: ['react'] },
      { t: 'typescript patterns for react hooks', fires: ['code', 'react'] },
      { t: 'javascript array methods inside jsx', fires: ['code', 'react'] },
      { t: 'A tiny typescript rewrite of the {pkg} router', fires: ['code'] },
    ],
  },
  devops: {
    domain: 'dozer.example',
    slots: { tool: ['forge', 'dozer'] },
    pool: [
      { t: 'docker layer caching in practice', fires: ['devops'] },
      { t: 'kubernetes pod eviction — field notes', fires: ['devops'] },
      { t: 'Our ci cd pipeline, rebuilt on {tool}', fires: ['devops'] },
      { t: 'Zero-downtime deploy strategies', fires: ['devops'] },
      { t: 'terraform modules we actually reuse', fires: ['devops'] },
      { t: 'From docker compose to kubernetes', fires: ['devops'] },
      { t: 'Every deploy is a negotiation', fires: ['devops'] },
      { t: '{tool} runners and the ci cd bill', fires: ['devops'] },
      { t: 'terraform plan said 347 changes', fires: ['devops'] },
      { t: 'Registries, docker, and cold starts', fires: ['devops'] },
    ],
  },
  database: {
    domain: 'quilldb.example',
    slots: { db: ['quilldb', 'mazurka'] },
    pool: [
      { t: 'sqlite wal mode in production', fires: ['database'] },
      { t: 'postgres autovacuum mysteries', fires: ['database'] },
      { t: 'indexeddb transactions — the missing manual', fires: ['database'] },
      { t: 'How the query planner reads statistics', fires: ['database'] },
      { t: 'b tree balancing, visualized', fires: ['database'] },
      { t: 'Every database is a cache you regret', fires: ['database'] },
      { t: 'sqlite vs postgres for edge sync', fires: ['database'] },
      { t: 'The query planner chose violence', fires: ['database'] },
      { t: 'database migration safety for {db}', fires: ['database'] },
      { t: 'A b tree walkthrough with real pages', fires: ['database'] },
    ],
  },
  compiler: {
    domain: 'brinelang.example',
    slots: { lang: ['brine', 'sluice'] },
    pool: [
      { t: 'Writing a lexer that avoids backtracking', fires: ['compiler'] },
      { t: 'The parser is the easy part', fires: ['compiler'] },
      { t: 'llvm intrinsics you should not touch', fires: ['compiler'] },
      { t: 'codegen for a tiny register machine', fires: ['compiler'] },
      { t: 'What our ast loses in lowering', fires: ['compiler'] },
      { t: 'Inside the {lang} compiler frontend', fires: ['compiler'] },
      { t: 'From lexer to parser without tears', fires: ['compiler'] },
      { t: 'Macro hygiene and the ast', fires: ['compiler'] },
      { t: 'A jit? no — an honest compiler', fires: ['compiler'] },
      { t: 'Peephole codegen notes', fires: ['compiler'] },
    ],
  },
  ml: {
    domain: 'tensorquay.example',
    slots: { lab: ['quay', 'mulberry'] },
    pool: [
      { t: 'Transformer attention patterns at scale', fires: ['ml'] },
      { t: 'Rotary embedding intuition', fires: ['ml'] },
      { t: 'Batched inference on tiny hardware', fires: ['ml'] },
      { t: 'fine tuning without melting the base model', fires: ['ml'] },
      { t: 'neural collapse in the last layer', fires: ['ml'] },
      { t: 'The llm eval that lied to us', fires: ['ml'] },
      { t: 'Paged kv and the inference bill', fires: ['ml'] },
      { t: 'embedding drift after a schema change', fires: ['ml'] },
      { t: 'A transformer from first principles', fires: ['ml'] },
      { t: 'Why every {lab} llm demo hides the queue', fires: ['ml'] },
    ],
  },
  'browser-internals': {
    domain: 'chromiumdocs.example',
    slots: { team: ['render', 'platform'] },
    pool: [
      { t: 'The chromium compositor thread, explained', fires: ['browser-internals'] },
      { t: 'Inside v8: hidden classes', fires: ['browser-internals'] },
      { t: 'blink layout in 2026', fires: ['browser-internals'] },
      { t: 'The service worker is your real backend', fires: ['browser-internals'] },
      { t: 'webextension polyfill sharp edges', fires: ['browser-internals'] },
      { t: 'extension apis we wish existed', fires: ['browser-internals'] },
      { t: 'v8 inline caches reconsidered', fires: ['browser-internals'] },
      { t: 'Message routing inside chromium', fires: ['browser-internals'] },
      { t: 'service worker update races', fires: ['browser-internals'] },
      { t: 'How blink paints text for the {team} team', fires: ['browser-internals'] },
    ],
  },
  security: {
    domain: 'secmemos.example',
    slots: { team: ['blue', 'red'] },
    pool: [
      { t: 'xss payloads that survive sanitizers', fires: ['security'] },
      { t: 'csrf in a same-site world', fires: ['security'] },
      { t: 'cors preflight, again', fires: ['security'] },
      { t: 'content security policy nonces done right', fires: ['security'] },
      { t: 'Disclosing a vulnerability responsibly', fires: ['security'] },
      { t: 'Field-level encryption tradeoffs', fires: ['security'] },
      { t: 'xss and csrf: the duet nobody wants', fires: ['security'] },
      { t: 'The vulnerability was a missing header', fires: ['security'] },
      { t: 'Rolling a stricter content security policy', fires: ['security'] },
      { t: 'encryption at rest is not encryption in use', fires: ['security'] },
      { t: 'The {team} team tabletop: a cors postmortem', fires: ['security'] },
    ],
  },
  finance: {
    domain: 'ledgerline.example',
    slots: { co: ['northfeather', 'saltwick'] },
    pool: [
      { t: 'invoice numbering for humans', fires: ['finance'] },
      { t: 'The annual budget season', fires: ['finance'] },
      { t: 'A ledger of small decisions', fires: ['finance'] },
      { t: 'expense reports without tears', fires: ['finance'] },
      { t: 'Preparing your tax return early', fires: ['finance'] },
      { t: 'Every budget is a hypothesis', fires: ['finance'] },
      { t: 'General ledger vs the shadow sheet', fires: ['finance'] },
      { t: 'invoice reconciliation at month end', fires: ['finance'] },
      { t: 'Filing the {co} tax return twice (on purpose)', fires: ['finance'] },
      { t: 'Petty cash expense culture', fires: ['finance'] },
    ],
  },
  planning: {
    domain: 'roadmapp.example',
    slots: { team: ['atlas', 'beacon'] },
    pool: [
      { t: 'The roadmap is a letter of intent', fires: ['planning'] },
      { t: 'milestone zero: what counts', fires: ['planning'] },
      { t: 'sprint rituals that survive reorgs', fires: ['planning'] },
      { t: 'gantt charts for grown-ups', fires: ['planning'] },
      { t: 'backlog grooming — rename it', fires: ['planning'] },
      { t: 'Retrofitting the roadmap after layoffs', fires: ['planning'] },
      { t: 'A milestone you can actually verify', fires: ['planning'] },
      { t: 'The sprint ended; the sprint never ends', fires: ['planning'] },
      { t: 'Why gantt lied to the {team} board', fires: ['planning'] },
      { t: 'backlog zero is a myth', fires: ['planning'] },
    ],
  },
  api: {
    domain: 'apinotes.example',
    slots: { co: ['quillon', 'vespra'] },
    pool: [
      { t: 'rest api versioning, honestly', fires: ['api'] },
      { t: 'graphql fragments we regret', fires: ['api'] },
      { t: 'One endpoint to rule the bill', fires: ['api'] },
      { t: 'openapi codegen nights', fires: ['api', 'compiler'] },
      { t: 'The {co} sdk nobody wrote docs for', fires: ['api'] },
      { t: 'graphql over rest api — the decade', fires: ['api'] },
      { t: 'Every endpoint is a promise', fires: ['api'] },
      { t: 'Shipping the {co} sdk', fires: ['api'] },
      { t: 'rest api pagination without tears', fires: ['api'] },
      { t: 'Why openapi wins the long game', fires: ['api'] },
    ],
  },
  code: {
    domain: 'codelodge.example',
    slots: { book: ['pearls', 'patterns'] },
    pool: [
      { t: 'python packaging, the final boss', fires: ['code'] },
      { t: 'rust lifetimes explained with trains', fires: ['code'] },
      { t: 'golang channels for the weary', fires: ['code'] },
      { t: 'programming {book} still matter', fires: ['code'] },
      { t: 'Reading source code like a critic', fires: ['code'] },
      { t: 'python and the walrus operator', fires: ['code'] },
      { t: 'rust borrow checker peace treaty', fires: ['code'] },
      { t: 'Why golang keeps winning services', fires: ['code'] },
      { t: 'The programming style nobody enforces', fires: ['code'] },
      { t: 'source code as the only truth', fires: ['code'] },
    ],
  },
  css: {
    domain: 'styleforge.example',
    slots: { team: ['studio', 'atelier'] },
    pool: [
      { t: 'Modern css is a layout language', fires: ['css'] },
      { t: 'flexbox gap finally everywhere', fires: ['css'] },
      { t: 'grid layout for real dashboards', fires: ['css'] },
      { t: 'tailwind without the soup', fires: ['css'] },
      { t: 'The stylesheet was 40kb of fear', fires: ['css'] },
      { t: 'css nesting, reviewed kindly', fires: ['css'] },
      { t: 'Centering with flexbox, again', fires: ['css'] },
      { t: 'A grid layout you can reason about', fires: ['css'] },
      { t: 'Why tailwind wins the {team} argument', fires: ['css'] },
      { t: 'One stylesheet per team, please', fires: ['css'] },
    ],
  },
  debugging: {
    domain: 'bughut.example',
    slots: { day: ['tuesday', 'friday'] },
    pool: [
      { t: 'How to debug a heisenbug', fires: ['debugging'] },
      { t: 'That stack trace is lying', fires: ['debugging'] },
      { t: 'Reading a traceback bottom-up', fires: ['debugging'] },
      { t: 'The exception was the message', fires: ['debugging'] },
      { t: 'One breakpoint too late', fires: ['debugging'] },
      { t: 'debug builds still ship', fires: ['debugging'] },
      { t: 'Annotating the stack trace for humans', fires: ['debugging'] },
      { t: 'traceback archaeology 101', fires: ['debugging'] },
      { t: 'Catch the exception, not the vibe', fires: ['debugging'] },
      { t: 'A breakpoint diet that works every {day}', fires: ['debugging'] },
    ],
  },
  design: {
    domain: 'pixelbench.example',
    slots: { sprint: ['spring', 'autumn'] },
    pool: [
      { t: 'figma variables for theming teams', fires: ['design'] },
      { t: 'The mockup lied about density', fires: ['design'] },
      { t: 'wireframe first, pixels later', fires: ['design'] },
      { t: 'Web typography that respects the text', fires: ['design'] },
      { t: 'Our design system is a treaty', fires: ['design'] },
      { t: 'Handing off figma without tears', fires: ['design'] },
      { t: 'Every mockup needs an empty state', fires: ['design'] },
      { t: 'A wireframe you can test tuesday', fires: ['design'] },
      { t: 'typography choices that survive zoom', fires: ['design'] },
      { t: 'Evolving the design system in {sprint}, not forking it', fires: ['design'] },
    ],
  },
  docs: {
    domain: 'docsharbor.example',
    slots: { product: ['quilldb', 'dozer'] },
    pool: [
      { t: 'documentation as the product surface', fires: ['docs'] },
      { t: 'The readme is a handshake', fires: ['docs'] },
      { t: 'A field guide to onboarding', fires: ['docs'] },
      { t: 'tutorial hell is a curriculum problem', fires: ['docs'] },
      { t: 'The quick reference nobody skims', fires: ['docs'] },
      { t: 'The {product} manual you actually needed', fires: ['docs'] },
      { t: 'documentation driven development', fires: ['docs'] },
      { t: 'readme driven everything', fires: ['docs'] },
      { t: 'Every guide needs a map', fires: ['docs'] },
      { t: 'A reference so good it became the manual', fires: ['docs'] },
    ],
  },
  performance: {
    domain: 'perfline.example',
    slots: { team: ['platform', 'edge'] },
    pool: [
      { t: 'performance budgets that bite', fires: ['performance'] },
      { t: 'Chasing latency at the {team}', fires: ['performance'] },
      { t: 'The benchmark was a marketing page', fires: ['performance'] },
      { t: 'p95 is where users live', fires: ['performance'] },
      { t: 'A profile in courage — and flamegraphs', fires: ['performance'] },
      { t: 'profiling the renderer, week one', fires: ['performance'] },
      { t: 'Tail latency and the long pole', fires: ['performance'] },
      { t: 'Every benchmark needs a threat model', fires: ['performance'] },
      { t: 'p99 next, but p95 first', fires: ['performance'] },
      { t: 'From profile to fix in one pass', fires: ['performance'] },
    ],
  },
  research: {
    domain: 'scholarden.example',
    slots: { dept: ['systems', 'theory'] },
    pool: [
      { t: 'The paper everyone cites and nobody reads', fires: ['research'] },
      { t: 'arxiv digest — tuesday batch', fires: ['research'] },
      { t: 'study finds reading footnotes helps', fires: ['research'] },
      { t: 'A literature review in three acts', fires: ['research'] },
      { t: 'citation chains and borrowed certainty', fires: ['research'] },
      { t: 'replication note: the {dept} paper holds', fires: ['research'] },
      { t: 'arxiv at thirty — a retrospective', fires: ['research'] },
      { t: 'study finds coffee does nothing new', fires: ['research'] },
      { t: 'The literature review nobody updated', fires: ['research'] },
      { t: 'citation etiquette for practitioners', fires: ['research'] },
    ],
  },
  testing: {
    domain: 'testfoundry.example',
    slots: { repo: ['kestrel', 'marlow'] },
    pool: [
      { t: 'The unit test that caught prod', fires: ['testing'] },
      { t: 'e2e without the flakes', fires: ['testing'] },
      { t: 'vitest projects, one year in', fires: ['testing'] },
      { t: 'playwright tracing saved the release', fires: ['testing'] },
      { t: 'coverage is a compass, not a grade', fires: ['testing'] },
      { t: 'The assertion was the design', fires: ['testing'] },
      { t: 'Every unit test earns its keep', fires: ['testing'] },
      { t: 'e2e budgets for honest teams', fires: ['testing'] },
      { t: 'Migrating {repo} to vitest, calmly', fires: ['testing'] },
      { t: 'playwright fixtures we keep reusing', fires: ['testing'] },
      { t: 'Raising coverage without lying', fires: ['testing'] },
      { t: 'The missing assertion in the plan', fires: ['testing'] },
    ],
  },
  writing: {
    domain: 'inkwell.example',
    slots: { mag: ['the drift', 'margin notes'] },
    pool: [
      { t: 'The essay as an argument with yourself', fires: ['writing'] },
      { t: 'draft zero is allowed to be bad', fires: ['writing'] },
      { t: 'A blog post a week, honestly', fires: ['writing'] },
      { t: 'The manuscript found its voice', fires: ['writing'] },
      { t: "Kill your essay's first paragraph", fires: ['writing'] },
      { t: 'From draft to published in four passes', fires: ['writing'] },
      { t: 'The blog post that outlived the startup', fires: ['writing'] },
      { t: 'Querying agents with the manuscript', fires: ['writing'] },
      { t: 'Submitting the essay to {mag}', fires: ['writing'] },
    ],
  },
};

// ── Adversarial pools (cluster 12) ───────────────────────────────────────────
const DEVANAGARI = [
  'सपना देखना एक अच्छी बात है',
  'मेरी पसंदीदा किताबें और कहानियाँ',
  'दिल्ली की सर्दियों की कहानियाँ',
  'आज का राशिफल और दिनभर की योजना',
  'बच्चों के लिए पढ़ाई के तरीके',
  'पुरानी यादें और नई उम्मीदें',
  'घर का बना खाना सबसे अच्छा',
];
const ENG_THIN = [
  'Weekend reading pile',
  'Misc — saved stuff',
  'Open loops and half ideas',
  'Pages I refuse to close yet',
  'Parking lot for tuesday',
  'That one page with the thing',
  'Notes to self — late july',
  'Random finds from the feed',
];
// Inside-word traps: every lexicon-looking token is glued inside a longer word,
// so the full-word boundary law must refuse to fire. Yield is the only honest
// answer. ("subledger" guards the ledger substring, "preact" guards react.)
const TRAP_INSIDE = [
  'githubber culture notes',
  'typescripting my way out',
  'dockers anonymous weekly',
  'reactjs confessional booth',
  'compilerx diaries — season two',
  'subledger folklore and myths',
  'preact vs preactifying, again',
  'kubernetesed, whatever that means',
];
const CHAFF_SINGLE = [
  ['Meeting invite: thursday one-on-one'],
  ['Your cart misses you'],
  ['The group chat erupted at midnight'],
  ['Morning headline — quick scan'],
];
const CHAFF_MULTI = [
  { titles: ['Gmail inbox (4 unread)', 'Your weekly newsletter digest'], accepted: ['email'] },
  {
    titles: ['Calendar — week 31', 'Meeting invite roundup', 'Your schedule, condensed'],
    accepted: ['calendar'],
  },
  { titles: ['slack huddles recap', 'discord — group chat threads'], accepted: ['chat'] },
  { titles: ['Your cart (2)', 'checkout help center'], accepted: ['shopping'] },
  // Reachability guarantees (G4): every chaff term fires at least one row —
  // pairings keep z ≥ 0.6 so the register names its own truth.
  {
    titles: ['price tracker — wishlist only', 'Your cart (2)', 'checkout help center'],
    accepted: ['shopping'],
  },
  {
    titles: ['order history — the returns corner', 'Your cart misses you'],
    accepted: ['shopping'],
  },
  {
    titles: ['breaking news — noon edition', 'The daily briefing, summarized'],
    accepted: ['news'],
  },
];

const fillSlots = (rand, pick, title, slots) => {
  let out = title;
  for (const [key, options] of Object.entries(slots)) {
    while (out.includes(`{${key}}`)) out = out.replace(`{${key}}`, pick(options));
  }
  return out;
};

/** Build one expect-name row from a cluster definition. */
const signalRow = (rand, pick, ints, clusterId, def, idx, mixed) => {
  const pool = shuffle(rand, def.pool);
  const titleCount = ints(2, Math.min(5, pool.length));
  const chosen = pool.slice(0, titleCount);
  const tabs = [];
  const accepted = new Set();
  for (const tpl of chosen) {
    tabs.push({
      title: fillSlots(rand, pick, tpl.t, def.slots),
      rootDomain: def.domain,
    });
    for (const f of tpl.fires) accepted.add(f);
  }
  // Mixed rows: sprinkle chaff from DISTINCT chaff frames (max 2) — the signal
  // keeps ≥2 term-hits so a chaff frame can never take the top (ADR note math).
  if (mixed) {
    const chaffPicks = shuffle(rand, CHAFF).slice(0, ints(1, 2));
    const seenFrames = new Set();
    for (const c of chaffPicks) {
      const frame = c.fires[0];
      if (seenFrames.has(frame)) continue;
      seenFrames.add(frame);
      tabs.push({ title: c.t, rootDomain: c.domain });
    }
  }
  const rootDomains = [...new Set(tabs.map((t) => t.rootDomain))];
  return {
    id: `${clusterId}-${String(idx + 1).padStart(2, '0')}`,
    cluster: clusterId,
    tabCount: tabs.length,
    rootDomains,
    takenAt: BASE_WALL + ints(0, 2_592_000_000), // within ~30 days, seeded
    tabs,
    expect: 'name',
    accepted: [...accepted].sort(),
  };
};

export const buildCorpus = () => {
  const rand = mulberry32(CORPUS_SEED);
  const pick = makePick(rand);
  const ints = makeInts(rand);
  const rows = [];

  // Clusters 1–10: pure signal missions (some rows carry chaff garnish).
  for (const [clusterId, def] of Object.entries(CLUSTERS)) {
    for (let i = 0; i < ROWS_PER_CLUSTER; i += 1) {
      // Every fourth row is chaff-garnished; every signal cluster contributes.
      const garnished = i % 4 === 3;
      rows.push(signalRow(rand, pick, ints, clusterId, def, i, garnished));
    }
  }

  // Cluster 11: mixed chaff-heavy missions — signal must win the name.
  const mixedSources = shuffle(rand, Object.entries(CLUSTERS)).slice(0, 4);
  for (let i = 0; i < ROWS_PER_CLUSTER; i += 1) {
    const [clusterId, def] = mixedSources[i % mixedSources.length] ?? ['github', CLUSTERS.github];
    const row = signalRow(rand, pick, ints, clusterId, def, i, true);
    // Guarantee ≥2 distinct chaff frames when the pool allows it.
    const extra = CHAFF.filter((c) => !tabsFrames(row).has(c.fires[0]));
    const picked = shuffle(rand, extra).slice(0, 2);
    const frames = new Set();
    for (const c of picked) {
      if (frames.has(c.fires[0])) continue;
      frames.add(c.fires[0]);
      row.tabs.push({ title: c.t, rootDomain: c.domain });
    }
    row.tabCount = row.tabs.length;
    row.rootDomains = [...new Set(row.tabs.map((t) => t.rootDomain))];
    row.id = `mixed-${String(i + 1).padStart(2, '0')}`;
    row.cluster = 'mixed';
    rows.push(row);
  }

  // Cluster 12: adversarial honesty rows (all expect-yield except named chaff).
  const advRows = [];
  const pushYieldRow = (idPrefix, idx, titles, domain) => {
    const tabs = titles.map((title) => ({ title, rootDomain: domain }));
    advRows.push({
      id: `${idPrefix}-${String(idx + 1).padStart(2, '0')}`,
      cluster: 'adversarial',
      tabCount: tabs.length,
      rootDomains: [...new Set(tabs.map((t) => t.rootDomain))],
      takenAt: BASE_WALL + ints(0, 2_592_000_000),
      tabs,
      expect: 'yield',
      accepted: [],
    });
  };
  const devSets = [
    [DEVANAGARI[0], DEVANAGARI[1]],
    [DEVANAGARI[2]],
    [DEVANAGARI[3], DEVANAGARI[4]],
    [DEVANAGARI[5]],
    [DEVANAGARI[6], DEVANAGARI[0]],
    [DEVANAGARI[1], DEVANAGARI[3], DEVANAGARI[5]],
  ];
  devSets.forEach((titles, i) =>
    pushYieldRow('devanagari', i, compact(titles), 'samachar.example'),
  );
  const thinSets = [
    [ENG_THIN[0], ENG_THIN[1]],
    [ENG_THIN[2]],
    [ENG_THIN[3], ENG_THIN[4]],
    [ENG_THIN[5]],
    [ENG_THIN[6], ENG_THIN[7]],
  ];
  thinSets.forEach((titles, i) => pushYieldRow('eng-thin', i, compact(titles), 'misc.example'));
  CHAFF_SINGLE.forEach((titles, i) => pushYieldRow('chaff-single', i, titles, 'chaff.example'));
  const trapSets = [
    [TRAP_INSIDE[0], TRAP_INSIDE[4]],
    [TRAP_INSIDE[1], TRAP_INSIDE[5]],
    [TRAP_INSIDE[2], TRAP_INSIDE[6]],
    [TRAP_INSIDE[3], TRAP_INSIDE[7]],
  ];
  trapSets.forEach((titles, i) => pushYieldRow('trap-inside', i, titles, 'trap.example'));
  CHAFF_MULTI.forEach((row, i) => {
    const tabs = row.titles.map((title) => ({ title, rootDomain: 'chaff.example' }));
    advRows.push({
      id: `chaff-multi-${String(i + 1).padStart(2, '0')}`,
      cluster: 'adversarial',
      tabCount: tabs.length,
      rootDomains: ['chaff.example'],
      takenAt: BASE_WALL + ints(0, 2_592_000_000),
      tabs,
      expect: 'name',
      accepted: [...row.accepted],
    });
  });
  rows.push(...advRows);
  return { schema: CORPUS_SCHEMA, seed: CORPUS_SEED, rows };
};

const compact = (arr) => arr.filter((x) => typeof x === 'string');
const tabsFrames = (row) =>
  new Set(CHAFF.filter((c) => row.tabs.some((t) => t.title === c.t)).map((c) => c.fires[0]));

export const serializeCorpus = (corpus) => `${JSON.stringify(corpus, null, 2)}\n`;

const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const checkMode = process.argv.includes('--check');
  const next = serializeCorpus(buildCorpus());
  if (checkMode) {
    const committed = readFileSync(OUT_PATH, 'utf8');
    if (committed !== next) {
      console.error(
        'shadow-corpus: missions.json is NOT the seeded artifact — run `pnpm gen:shadow-corpus` and commit the result.',
      );
      process.exit(1);
    }
    console.info('shadow-corpus: missions.json is the seeded artifact (byte-exact).');
    process.exit(0);
  }
  writeFileSync(OUT_PATH, next);
  console.info(
    `shadow-corpus: ${String(next.length)} bytes, ${String(buildCorpus().rows.length)} rows written.`,
  );
}
