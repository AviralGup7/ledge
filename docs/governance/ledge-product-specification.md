# LEDGE — COMPLETE PRODUCT SPECIFICATION
### Version 1.0 · Single Source of Truth
*Derived from the locked Product Vision. Nothing in this document may violate the five commandments: Never lose a thought · Closing is keeping · Zero gardening · Felt, not seen · Exit means export. Where any ambiguity arises in future work, this document resolves it; where this document is silent, the commandments decide.*

---

# 1. PRODUCT STRUCTURE

## 1.1 Design rule: minimum objects, maximum clarity

The specification recognizes **six user-facing concepts** and **two internal systems**. Nothing else exists. If a future feature requires a new object, it must prove the object cannot be expressed as a state or view of an existing one.

| # | Concept | Type | One-line definition |
|---|---|---|---|
| 1 | **Tab** | Object (user-facing) | A unit of thinking: a page the user opened, with its context |
| 2 | **Mission** | Container (the ONLY container) | A named cluster of tabs that constitutes "the thing I'm working on" |
| 3 | **Session** | Object (internal, surfaced read-only) | An immutable point-in-time snapshot of a window or mission |
| 4 | **Journal** | System (internal) | Append-only event log: the crash-proof substrate beneath everything |
| 5 | **Memory** | System (internal) | The derived AI layer: summaries, topics, links, learned vocabulary |
| 6 | **Recently Closed** | View | Closed tabs/missions inside their retention window |
| 7 | **Archive** | View | All parked and archived missions: the permanent library |
| 8 | **Trash** | View + safety buffer | Recently deleted items, auto-purged after 30 days |

**Explicitly deleted concepts** (discussed and rejected): *Workspace* (redundant — a Mission IS the workspace), *Folder*, *Collection*, *Space*, *Project* (synonyms of Mission; one container, one name), *Bookmark* (subsumed by parked Tabs) and user-managed **Tags** (replaced by AI Topics, §3.6). Rationale: every additional container type is a gardening tax and an IA fork the user must maintain. Views are free; containers are expensive.

## 1.2 The object model, in one diagram (text form)

```
JOURNAL (append-only, owns the truth)
   └─ produces → SESSION (snapshots of Window/Mission state)
   
TAB ──belongs to──► MISSION (1 : N — a tab has exactly one home mission)
   │                    │
   │                    ├─ has ─► SUMMARY (AI, in Memory)
   │                    ├─ has ─► TOPICS (AI, correctable)
   │                    └─ linked ◄─► LINKS to other Missions (AI, confidence-scored)
   
STATES (missions):  OPEN ⇄ PARKED ⇄ ARCHIVED (concluded = flag on ARCHIVED)
STATES (tabs):      LIVE ⇄ KEPT → TRASH → purged
VIEWS:              Recently Closed, Archive, Trash, Search Results
```

## 1.3 Object definitions

### 1.3.1 TAB
The atomic unit. Exists in two states:

| State | Meaning |
|---|---|
| **LIVE** | Currently open in a browser window |
| **KEPT** | Parked (closed-without-loss); stored with its context |

**Metadata:** `url` · `title` · `favicon` · `firstSeenAt` · `lastActiveAt` · `missionId` · `origin` (opened-by-user / parked-from-window-X / imported) · `scrollDepthEstimate` (best-effort, no guarantees) · `userNote` (optional, rare) · `topicRefs` (AI-derived) · `contentIndex` (opt-in local full-text index flag).

**Explicit non-fields (privacy law):** no form contents, no keystrokes, no cookies, no credentials, no page body by default (full-text indexing is opt-in per §6.8). Scroll depth is a hint, never a promise — we do not sell certainty we cannot guarantee.

**Lifecycle:** Opened as LIVE → parked by user gesture or explicit rule → KEPT → reopened (returns to LIVE, remains recorded in mission history) → user-deleted → TRASH (30 days) → purged permanently. System-initiated purge applies ONLY to Recently Closed items past their retention window, never to KEPT items. **Parked tabs live forever unless the user deletes them.**

### 1.3.2 MISSION
The canonical container and the product's center of gravity. A mission is "a thread of thinking: the visa, the CRM evaluation, the thesis chapter."

**States:**

| State | Definition | Visible in | AI behavior |
|---|---|---|---|
| **OPEN** | Has ≥1 live tab in a window | Strip guardian, switcher | Keeps name/summary current |
| **PARKED** | All tabs kept, none live; resume-eligible | Archive (top), resumption cards | Holds resumption brief ready |
| **ARCHIVED** | Concluded or long-shelved; retrieval-only | Archive (library) | Indexed for semantic memory; never nags about it |

**"Concluded" is a flag + optional outcome note on an ARCHIVED mission, not a fourth state.** (See §9.2 — the vision's "Done" state folded in to avoid state bloat.) Concluding is the satisfying closure gesture: *"CRM decision — chose Acme; reasons noted."* Outcome notes become the richest retrieval material in the entire archive.

**Metadata:** `id` · `name` (always present — "Untitled" is forbidden) · `namedBy` (ai / ai-corrected / user) · `createdAt` · `lastActiveAt` · `state` · `concluded` + `outcomeNote` · `tabIds` · `topicRefs` · `summaryRefs` · `windowBinding` (which window it currently lives in, if OPEN).

**Lifecycle:** Born (auto-formed by AI clustering or one user gesture) → OPEN ⇄ PARKED (unlimited transitions) → ARCHIVED (explicit gesture, or inactive 90+ days *only after user confirmation* — archiving is never silent) → user-deleted → Trash → purged. Resuming an ARCHIVED mission returns it to OPEN. Missions never expire and are never deleted by the system.

### 1.3.3 SESSION
An **immutable snapshot**: the state of a window or mission at a moment in time. Sessions are the version history of missions — the "safety film" running under live work.

**Triggers:** automatic rolling capture (interval + on-significant-change), on park, on crash/abnormal shutdown, on user gesture ("snapshot now" is a power feature).

**User surface:** read-only. "See this mission as it was on June 3" (post-MVP, §4). Sessions are never edited, never deleted individually by the user; they age out on a rolling schedule (default: keep 30 days of snapshots per mission) and they die with their mission.

### 1.3.4 JOURNAL
Append-only event log: every open, close, move, park, restore, edit. The Journal is the ground truth from which current state is derived and from which any loss is replayed. **Ownership rule: the local Journal is canonical; sync carries encrypted replicas (§1.3.7).** It is never exposed as a feature; it is exposed through its outcomes (crash recovery, Recently Closed, undo). Retention: full fidelity 30 days; compacted thereafter.

### 1.3.5 MEMORY
The derived AI store: mission summaries, resumption briefs, topics, inter-mission links, learned vocabulary and correction history. **Memory is derived, never primary — it can always be regenerated from the Journal + tabs.** Deletion law: derived data dies with its source (delete a mission → its summaries, topics, and links are permanently destroyed). Memory is never exported as raw model output; it rides inside mission/tab exports as human-readable text.

### 1.3.6 RECENTLY CLOSED, ARCHIVE, TRASH (the views)
- **Recently Closed:** everything closed within the retention window (default 30 days; user-configurable 7/30/90; unlimited retained for Ledge+). Automatic, aging, *protection you never asked for.*
- **Archive:** all PARKED + ARCHIVED missions. Permanent, deliberate. The library.
- **Trash:** user-deleted items, 30-day buffer, then purged. Restorable in one gesture. Trash never contains system-removed items (the system removes nothing on its own except aged-out Recently Closed entries, which bypass Trash as an explicit, documented behavior).

## 1.3.7 Ownership model
- **Single-player only.** Every object is owned by exactly one user; there is no shared editing, no team space, no inheritance. Sharing exists only as one-way export artifacts (link or file, §4 Advanced) — a snapshot, not a collaborative object.
- **Canonical store:** the user's device. Cloud sync (Ledge+) holds end-to-end-encrypted replicas keyed by a user-held phrase; the service can delete replicas but never read them.
- **Account deletion** (sync users): encrypted replicas purged immediately; local data untouched and fully functional.

## 1.4 Deletion & recovery rules (canon table)

| Action | Initiated by | Result | Recoverable? |
|---|---|---|---|
| Close a tab (normal) | user | Enters Recently Closed | Yes, within retention window |
| Park tab/mission | user gesture or explicit rule | KEPT in mission, forever | N/A (nothing was lost) |
| Archive a mission | user (confirmed) | Moved to library | Trivially (resume restores) |
| Delete tab/mission | user | Trash, 30 days | One gesture |
| Purge Trash | system, after 30 days | Permanent destruction of content + derived Memory | **No** |
| Age-out of Recently Closed | system, at retention limit | Entry removed (was never "saved") | No (documented, expected) |
| Browser crash | accident | Nothing: Journal holds truth; restore offered | Fully — the witnessing moment |
| Uninstall extension | user | Local export offered before removal; data file left intact | Reinstall recovers if export/file kept |

**Recovery precedence:** Undo (in-session) → Recently Closed → Trash → Session snapshot → Exported file. Every surface that can destroy must show the way back.

---

# 2. USER WORKFLOWS

*Format for all workflows: Goal → User actions → System response → AI behavior → Failure handling.*

## W1 — First launch (the 60-second relief sequence)
- **Goal:** Feel relief within one minute; trust within one day. Zero configuration.
- **Actions:** Install. One welcome pane: three sentences ("Your tabs become safe. Closing becomes keeping. Nothing leaves this device.") + one button: **"Make my browser calm."**
- **System response:** Reads current windows; forms draft missions; shows the result: *"Found 47 open tabs → 6 missions"* with names already filled. Safety heartbeat activates: **"47 tabs safe · just now."** Offers optional import (W15) and optional tour (skippable, three cards max). No account prompt. No permission escalation beyond core.
- **AI:** Clusters tabs into draft missions, names each, dedupes open duplicates (marks, does not close). Confidence shown subtly per mission ("suggested grouping").
- **Failure:** If clustering yields low confidence → fall back to time/domain grouping with honest labels ("Work tabs · saved 4:32 pm"). If zero tabs open → clean empty state (§5.9). Onboarding MUST NOT block on AI; heuristics alone deliver a coherent first screen.

## W2 — Implicit mission formation (zero gardening in motion)
- **Goal:** Missions appear without the user ever creating structure.
- **Actions:** None. User browses normally.
- **System response:** As browsing accrues topical coherence (a cluster of same-intent tabs within a time window), the tabs are grouped under a mission with an AI name. The grouping is visible and correctable, never hidden.
- **AI:** Names ("Flywheel pricing research"), assigns confidence, watches for drift (a tab that doesn't belong → suggests moving, one tap).
- **Failure:** Wrong grouping → user drags tab to another mission (W16); AI records the correction and does not re-attempt the same grouping. Never argue with the user. Never re-cluster what a user has manually arranged.

## W3 — Starting a mission deliberately (the clean-slate persona)
- **Goal:** One gesture: "I'm beginning the apartment hunt now."
- **Actions:** Shortcut or strip-guardian + : "Start mission" → optional name (may skip) → a fresh window bound to the mission.
- **System response:** New window visually identified with the mission (native tab-group styling, mission name). From now on, tabs opened in this window join the mission.
- **AI:** If unnamed, names from the first few tabs. Begins building the summary immediately.
- **Failure:** User abandons immediately (0–1 tabs after 24h) → mission quietly dissolves into Recently Closed. It never litters the Archive.

## W4 — Parking (the core gesture: closing is keeping)
- **Goal:** Close without loss, with instant proof of safety.
- **Actions:** Four granularities, all one gesture: park this tab · park this group · park this window (mission) · park everything. Via keyboard, context menu, or strip guardian.
- **System response:** Tabs close. Immediate confirmation with substance (not decoration): **"Apartment hunt parked — 23 tabs. Resume anytime."** The safety heartbeat increments visibly. Every park captures a Session snapshot first (snapshot → then close; never reverse the order).
- **AI:** Refreshes mission summary and resumption brief at park time: *"You were deciding between two neighborhoods; three listings still open with filters set."*
- **Failure:** Snapshot capture error → DO NOT close the tabs; show honest state ("Couldn't secure 2 tabs — left open"), retry. **A park that can't be guaranteed never proceeds.** This is the most important failure rule in the product.

## W5 — Resuming / restoring
- **Goal:** Restore the thought, not just the URLs.
- **Actions:** From resumption card ("Resume") · from Archive click · from Reflex Search result · partial restore (pick 5 of 23 tabs).
- **System response:** Mission returns to OPEN state in its own window/binding. Restoration is *orderly*: tabs appear grouped, active tab = last active where known. The resumption brief is shown once, dismissibly, at window top.
- **AI:** Delivers the brief: what this mission was, where you left off, what's still pending ("2 of 3 comparisons finished").
- **Failure:** Dead URLs (410s, moved): restored tabs show a subtle "may have moved" marker; offer archived-text peek if content index existed (opt-in users), else offer to remove. Partial failures never block the rest of the restore.

## W6 — Reflex Search (the sense organ)
- **Goal:** Find anything — open, parked, closed, seen — faster than re-googling.
- **Actions:** One global shortcut (default ⌘⇧K / Ctrl+Shift+K, remappable) from anywhere → type → arrow → enter. Also embedded in the quiet page.
- **System response:** Unified results across LIVE, KEPT, Recently Closed, and (opt-in) indexed content, ranked by recency × relevance × open-state. Enter = open/resume; modifiers = park, copy link, peek.
- **AI:** Understands intent beyond keywords: "purple pricing table march," "the article about retention," "visa photo requirements." Free tier: fast title/URL/topic matching; Ledge+: semantic embeddings + full-text (local-first processing).
- **Failure:** No results → widen scope automatically (Recently Closed → history-adjacent suggestions) and say what was searched ("Nothing kept matches — showing open tabs and recently closed"). Never a dead end.

## W7 — Crash recovery (the witnessing moment)
- **Goal:** After the worst day, nothing happened. Literally.
- **Actions:** Relaunch browser.
- **System response:** Calm banner, zero drama: **"Chrome closed unexpectedly. Everything is safe — 47 tabs, 6 missions, as of 2 min before."** One button: **"Put everything back."** Secondary: "Review first" (the anxious user verifies; we honor verification).
- **AI:** Reassembles missions exactly as they were (names, grouping, last-active tab), because missions are Journal-derived, not window-derived.
- **Failure:** Partial journal write on the crash boundary → recover to last consistent snapshot, disclose precisely what couldn't be guaranteed ("restored to 2:41 pm; 3 tabs after that may be in Recently Closed"). Precision is trust; vagueness is suspicion.

## W8 — Switching projects (the context switcher's superpower)
- **Goal:** Leap between mental contexts without residue.
- **Actions:** One shortcut → Switcher (all missions, open first, parked next) → choose. Optional modifier: "park current, then switch."
- **System response:** Park-current-then-switch executes W4+W5 atomically: snapshot → park → resume target. Old context vanishes fully; new context arrives with its brief.
- **AI:** Brief emphasizes *resumption delta*: "Last here: Tuesday. Since then, 2 tabs auto-kept from your phone (Ledge+ sync users)."
- **Failure:** If park fails (W4 rule), switch aborts with clear language; user never loses the current context by half-executing a switch.

## W9 — Morning resume (the card)
- **Goal:** Monday remembers Friday.
- **Actions:** Open browser. One card, dismissible, no pressure.
- **System response:** At most once per session-start: **"Friday's open threads"** — up to 3 open/parked missions with one-line briefs and a Resume button each. Card never auto-resumes; never repeats after dismissal that day.
- **AI:** Ranks by last-active × staleness × apparent unfinishedness; writes the one-liners.
- **Failure:** No compelling threads → no card. Absence is a feature (§7, Silence). If AI uncertain, show nothing rather than nag wrongly.

## W10 — Cross-device resume (Ledge+)
- **Goal:** The layer persists across machines.
- **Actions:** Set up sync on second device via key phrase. Open browser there.
- **System response:** Missions (parked + archived + open-state of *other* devices) visible; resume a mission parked on the laptop. Open tabs of *this* device remain local by default (cross-device live-tab takeover is future-scope).
- **AI:** Merge conflicts resolved as union (never overwrite); summaries regenerate post-merge.
- **Failure:** Conflict impossible to merge cleanly → keep both, mark one "recovered copy," let user merge by drag. E2E keys missing → sync pauses; local data untouched; plain-language explanation.

## W11 — Duplicate handling
- **Goal:** The same page never taxes attention twice.
- **Actions:** None required (passive), or one tap on the marker.
- **System response:** Open duplicates get a subtle marker + one-tap ("close 2 duplicates — they stay kept"). When opening a URL already kept in a mission, a whisper: *"Already kept in 'CRM comparison' · parked Mar 4"* with jump-to.
- **AI:** Near-duplicate detection (tracking-parameter stripping, canonical URL resolution, same-article-different-source flagging at lowered confidence).
- **Failure:** False positive → user taps "not a duplicate"; AI whitelists the pair permanently for this user.

## W12 — Archiving & concluding
- **Goal:** Move finished/latent work into the permanent library, with meaning preserved.
- **Actions:** Mission menu → Archive, or Archive-and-conclude (add outcome note, optional).
- **System response:** Mission leaves daily surfaces, joins the library. Concluded missions show their outcome note as a badge in the Archive.
- **AI:** Final summary upgrade (full thread narrative); topic extraction for future semantic retrieval; links to related missions refreshed.
- **Failure:** User archives accidentally → universal Undo (10s toast) plus Trash-level trivial restoration (resume it).

## W13 — Deleting & accidental-deletion recovery
- **Goal:** Deletion exists, is honest, anderror-tolerant.
- **Actions:** Delete tab/mission (keyboard, menu, bulk).
- **System response:** Undo toast (always). Item in Trash 30 days. Trash page: plain list, restore or empty-now. Derived Memory is queued for destruction with the item and destroyed at purge.
- **AI:** None. Deletion must never involve AI judgment.
- **Failure:** Bulk-delete of >20 items → secondary confirm with exact counts. No exceptions; anxious users delete in panic sometimes — the Trash is designed for their worst moment, not their best.

## W14 — Exporting (the exit that builds trust)
- **Goal:** Anything, anytime, in open formats, one click.
- **Actions:** From any mission: Export. From settings: Export everything.
- **System response:** Formats: HTML (human-readable, opens anywhere), JSON (complete fidelity), Markdown (portable notes-style). Mission export includes summary and outcome note as readable text. No paywall, no account, no throttle.
- **AI:** None beyond rendering existing summaries into the export.
- **Failure:** Large exports stream in parts with progress; a failed export never produces a partial silent file — verify then present.

## W15 — Importing (reciprocity: bring your exile with you)
- **Goal:** Convert refugees from incumbent tools in minutes.
- **Actions:** Settings → Import → OneTab export / Session Buddy JSON / browser bookmarks HTML / Ledge export file.
- **System response:** Preview before commit (counts, detected structure), then import as one new mission per source-group (re-namable later), timestamps preserved where known.
- **AI:** Re-clusters flat legacy lists into draft missions; dedupes against existing archive.
- **Failure:** Unrecognized file → say exactly which formats are supported and fail safe. Partial import on corrupt rows → import the good, report the bad as a downloadable list.

## W16 — Corrections (the one-gesture teaching loop)
- **Goal:** Fix AI judgment in one move; teach forever.
- **Actions:** Rename mission · drag tab between missions · merge two missions · split selection into new mission · "not a duplicate."
- **System response:** Immediate application, undoable. Correction recorded in Memory as preference (vocabulary, grouping taste), visibly acknowledged once ("Got it"), never repeatedly.
- **AI:** Learns: user's real project names, tolerance for mission size, domain tastes ("Keep all AWS docs together"). Never re-litigates a corrected decision silently.
- **Failure:** Correction conflicts with an active rule → rule loses; explicit beats inferred, always.

---

# 3. INFORMATION ARCHITECTURE

## 3.1 Hierarchy depth: exactly two levels
**Mission → Tab.** Full stop. Two levels are the maximum a human navigates without maps. Everything else is a view (state-filtered lens) or metadata (retrieval aid).

## 3.2 Container policy: one container, no exceptions
No folders, no collections, no workspaces, no spaces. The Archive is not a container — it is the set of missions in parked/archived state. Recently Closed is not a container — it is closed items within a retention window. Containers multiply; views don't.

## 3.3 Multi-membership: no; relationships: yes
A kept tab belongs to exactly one mission. Cross-cutting access is achieved by **search** (retrieval doesn't care about membership) and **AI Links** (§6.6) connecting *missions*, not tabs. Rationale: many-to-many membership is the single most common source of IA collapse in knowledge tools (duplicated entities, uncertain deletion semantics, sync-merge hell). Links preserve the benefit; membership preserves the sanity.

## 3.4 The Archive (how archived knowledge works)
- Read-optimized, library presentation: mission cards with name, state, tab count, last-active date, topics, outcome badge.
- Sort orders: Last active · Longest dormant · Most tabs · Alphabetical. Default: last active.
- Dormancy is surfaced honestly, not punished: a mission sleeping 8 months is *library stock*, exactly where it belongs.
- Semantic retrieval (Ledge+) treats the Archive as the primary corpus for "asking your own archive" (future, §4 Future).

## 3.5 Search (canonical behavior)
- **One box, one mental model:** it searches everything you still have — open, parked, recently closed, (opt-in) content — and ranks by open-first, recent-first, relevant-first.
- Progressive filters, never required: `is:open` `is:parked` `is:archived` `in:"mission name"` `before:` `after:`. Power syntax for power users; invisible to everyone else.
- Keyword matching (free) → semantic understanding (Ledge+). The search UX is identical; only comprehension depth changes. Search is never a separate "page" — it is a reflex layer over every surface, plus a full view inside the quiet page.

## 3.6 Tags: no. Topics: yes (derived, correctable)
User-managed tag taxonomies violate zero gardening — they are a chores system disguised as organization. Instead: **AI Topics** — flat labels extracted from content (" Schengen visa", "React hooks", "mid-range road bikes"), attached to tabs and missions, shown as chips, editable via correction (rename, remove). Topics are retrieval metadata and search ammunition, never a browsing hierarchy the user must maintain. Users who want strict manual tagging are explicitly not our design target (documented stance).

## 3.7 Should AI generate relationships?
Yes — as **suggestions with confidence**, never as structure. AI may link missions ("related: Lisbon flights ↔ Lisbon neighborhoods"), propose merges ("these two missions overlap 80%"), and surface "seen alongside" trails in search. It may never silently merge, split, or reorganize. Structure is user-ratified; relationships are AI-proposed.

## 3.8 Expiration policy
- Missions: **never expire, never auto-delete.**
- Recently Closed: expires per user-set retention (7/30/90 days; unlimited for Ledge+).
- Sessions: rolling 30-day per-mission freshness.
- Trash: 30 days, then purged.
- Memory items: die with their source; orphaned derived data is forbidden.
**Rule of thumb: automatic disappearance is allowed only for things the user never deliberately saved.** Anything the user touched deliberately is immortal until they kill it.

## 3.9 History vs. Archive (the intent axis)
They differ on two axes, and conflating them is a product sin:
| | Recently Closed ("history") | Archive |
|---|---|---|
| Why it exists | Automatic protection | Deliberate keeping |
| Content | Things you closed without deciding | Things you parked/concluded |
| Aging | Retention window | Permanent |
| Emotional role | Insurance | Library |
Never present Recently Closed as "saved," and never let the Archive age anything. Users must be able to form two crisp mental models with zero overlap.

---

# 4. FEATURE INVENTORY

*Complexity: S/M/L (design+behavior complexity, not engineering). Importance: P0 existential · P1 core · P2 valuable · P3 nice. Frequency: daily/weekly/rare per target user.*

## 4.1 CORE
| Feature | Purpose | Problem solved | Why users need it | Freq | Cmplx | Imp | MVP |
|---|---|---|---|---|---|---|---|
| Journal (continuous capture) | Crash-proof substrate | "Everything vanished" | Insurance is why this product exists | passive | M | P0 | ✅ |
| Park (4 granularities) | Closing is keeping | Fear of closing | The core gesture | daily ×N | M | P0 | ✅ |
| Missions (auto-formed) | Structure without gardening | Tab chaos, flat strip | Order that requires zero effort | daily | L | P0 | ✅ |
| Safety heartbeat ("276 tabs safe") | Object-permanence reassurance | Closing anxiety | The designed affect; ADHD-critical | passive | S | P0 | ✅ |
| Restore/Resume a mission | Bring context back | Recovering work | The payoff of parking | daily | M | P0 | ✅ |
| Reflex Search (unified) | Find anything fast | "Where is that tab" / re-researching | Replaces scavenger hunts; becomes reflex | daily ×N | L | P0 | ✅ |
| Recently Closed (retention) | Automatic safety net | Accidental closes | Zero-effort protection | weekly | S | P0 | ✅ |
| Auto-naming | Nothing is ever "Untitled" | Session sprawl ("Session 47") | Retrieval requires names | daily | M | P0 | ✅ |
| Basic summaries (mission one-liner) | What was this thread | Graveyard prevention | Names fade; summaries carry meaning | weekly | M | P1 | ✅ (v1 light) |
| Undo (universal, 10s) + Trash | Error tolerance | Fat-finger deletion, panic deletion | Safety for worst moments | rare | S | P0 | ✅ |
| Export (HTML/JSON/MD) | Exit means export | Trust, portability | The charter made real | rare | S | P0 | ✅ |
| Import (OneTab/SessionBuddy/bookmarks) | Refugee conversion | Switching cost | Funnels the displaced incumbents' users | once | M | P1 | ✅ |

## 4.2 ADVANCED
| Feature | Purpose | Problem | Why needed | Freq | Cmplx | Imp | MVP |
|---|---|---|---|---|---|---|---|
| Switcher (park+switch atomic) | Context leaping | Multi-project residue | Pro persona's superpower | daily | M | P1 | ⏳ v1.1 |
| Morning resume card | Monday remembers Friday | Resumption lag | Witnessing moment #2 | daily | M | P1 | ⏳ v1.2 |
| Resumption briefs (AI) | Restore thought not URLs | "Where was I?" | The differentiator | daily | L | P1 | ⏳ v1.1 |
| Duplicate detection | Attention tax | Dupes everywhere | Passive relief | daily | M | P1 | ⏳ v1.1 |
| Tab-sprawl nudge (1/day max) | Gentle hygiene | 60-tab strips | Respects silence while helping | rare | S | P1 | ⏳ v1.1 |
| E2E Sync (Ledge+) | Continuity across devices | Multi-machine life | Retention + revenue pillar | daily | L | P1 | ⏳ v2 |
| Session snapshots / "see mission on June 3" | Version history | "It was better before" | Deep trust | rare | M | P2 | ⏳ v2 |
| Archive conclude + outcome notes | Meaning preservation | "What did I decide?" | Second-brain material | weekly | S | P1 | ⏳ v1.2 |
| Rules (explicit, e.g., scheduled park prompt) | Configured automation | Night-time strip discipline | Power users; Ledge+ | rare | M | P2 | ⏳ v2 |
| Share session as link/file | Handing someone your research | "Here are my 20 tabs" | Viral loop; one-way artifact only | weekly | M | P2 | ⏳ v2 |

## 4.3 AI (invisible organ — never a chatbot)
| Responsibility | Purpose | Freq | Cmplx | Imp | MVP |
|---|---|---|---|---|---|
| Clustering | Form missions from chaos | continuous | L | P0 | ✅ |
| Naming | Name everything, human-plausible | continuous | M | P0 | ✅ |
| Summaries (mission & thread) | Meaning + resumption | on park/archive | L | P1 | ✅ light / ⏳ full |
| Resumption briefs | "Where you left off" | on resume | L | P1 | ⏳ |
| Duplicate intelligence | Passive dedupe | daily | M | P1 | ⏳ |
| Topics (flat chips) | Retrieval metadata | continuous | M | P1 | ⏳ |
| Relationship discovery (links/merge suggestions) | Connect knowledge | weekly | M | P2 | ⏳ v2 |
| Search understanding (semantic) | Beats memory | daily | L | P1 | ⏳ (Ledge+) |
| Intent extraction ("deciding between…") | Thought capture | continuous | L | P2 | ⏳ v2 |
| Correction learning | Personal vocabulary | continuous | M | P1 | ✅ basic / ⏳ deep |
| Confidence scoring | AI honesty | continuous | M | P0 | ✅ (embedded) |
| Recommendation timing | When to nudge | rare | M | P1 | ⏳ |

## 4.4 POWER USER
| Feature | Freq | Cmplx | Imp | MVP |
|---|---|---|---|---|
| Command palette (all verbs) | daily | M | P1 | ⏳ v1.1 |
| Full keyboard map (remappable) | daily | S | P1 | ✅ partial |
| Bulk select/operate (park 40, delete 20) | weekly | S | P1 | ✅ |
| Search filters (`is:`, `in:`, `before:`) | weekly | S | P2 | ⏳ |
| Snapshots on demand | rare | S | P2 | ⏳ v2 |
| Export scheduling (auto-export to file) | rare | S | P3 | ❌ (violates: silent background file writes; revisit) |

## 4.5 ACCESSIBILITY
| Feature | Freq | Cmplx | Imp | MVP |
|---|---|---|---|---|
| Full keyboard operability of every surface | daily | M | P0 | ✅ |
| Screen-reader labels + live regions (heartbeat announced politely) | daily | M | P0 | ✅ |
| High-contrast + reduced-motion modes | daily | S | P0 | ✅ |
| Calm copy standard (no urgency, no exclamation, no shame) | always | S | P0 | ✅ |
| Generous undo & confirmation thresholds (designed for panic moments) | rare | S | P0 | ✅ |
| Large-text/200% zoom integrity | daily | S | P1 | ✅ |

## 4.6 FUTURE (parked, vision-aligned, no commitment)
Ask-the-archive Q&A over your missions (semantic; still never a chatbot-on-everything — scoped to *your archive*) · timeline view · cross-device live-tab handoff · per-site full-text recall expansion · team-*adjacent* exports (artifacts only, never shared editing) · watch: browser-native session APIs maturing.

**Rejection log (features proposed and refused, with commandment violated):** standalone notes/tasks (III, scope) · streaks/scores (gamification) · social profiles (charter) · AI chatbot sidebar (AI-is-organ) · new-tab takeover default (trust) · auto-close/auto-archive without explicit rule + same-moment confirmation (IX/10) · reading-time analytics (surveillance-of-self) · folder hierarchy (IA collapse) · "free trial of keeping your own tabs" (hostage).

---

# 5. USER INTERACTION MODEL

## 5.1 Surfaces (exactly three — the vision is law)
1. **Strip guardian** — the park gesture, heartbeat, Start/Resume, the one-nudge-per-day slot.
2. **Reflex Search** — ⌘⇧K overlay; the sense organ.
3. **Quiet page** — missions, Archive, Recently Closed, Trash, settings, import/export. A place of business, never a destination feed.

## 5.2 Mouse
- Click mission chip → jump/resume. Right-click tab → "Park" / "Park all like this" (domain pattern). Right-click selection → bulk verbs.
- Quiet page: click cards to focus mission; buttons sized for stressed users (44px targets).
- All hover states deferred-reveal (no flicker storms while scanning).

## 5.3 Keyboard (defaults, all remappable; conflict audit on install)
| Action | Default |
|---|---|
| Reflex Search | ⌘⇧K / Ctrl+Shift+K |
| Park current tab | ⌥⇧X / Alt+Shift+X |
| Park window (mission) | ⌥⇧W / Alt+Shift+W |
| Park everything | ⌥⇧E / Alt+Shift+E |
| Switcher | ⌘⇧Space / Ctrl+Shift+Space |
| Start mission | ⌥⇧N / Alt+Shift+N |
| Undo (within Ledge surfaces) | ⌘Z / Ctrl+Z |
Conflict detection at install: if binding taken, auto-assign next free and say so once, plainly.

## 5.4 Command palette
Verb-first ("park…", "resume…", "export…", "merge…"), powered by the search corpus. Palette IS Reflex Search scoped to commands (one mechanism, two doors) — see §9 de-duplication.

## 5.5 Context menus
Tab strip, page, selection, and mission-card menus. Menus show state-specific verbs only (a parked tab offers "Reopen," never "Park"). No menu deeper than two levels.

## 5.6 Drag and drop
Tabs → mission chips (move/assign); tabs → quiet-page missions; mission → mission (merge, with confirm); selection → "new mission." Every drop is undoable in one gesture. Drag previews are honest (show what will actually happen).

## 5.7 Quick actions
On any tab/result: open/resume · park · copy link · peek (preview without committing) · assign to mission. Peek exists because anxious users don't trust clicks — previewing must never mutate state.

## 5.8 Notifications (charter-tier policy)
- **Default: silence.** Allowed classes: crash-recovery banner (always allowed — it's the product's promise), one optional tab-sprawl nudge/day (opt-out; three dismissals = never again per type), sync problem notice (actionable only), scheduled-park rule prompts (only if user authored the rule).
- **Forbidden forever:** streaks, tips-of-the-day, "you have 200 tabs 😱", win-back, engagement digests, AI "insights" newsletters.
- Heartbeat is NOT a notification: a passive, always-visible state indicator (badge-level), updated silently.

## 5.9 Empty states (designed, four only)
1. **Pre-first-run:** the three-sentence welcome (W1).
2. **Clear strip:** *"Nothing open. Everything is kept."* — positive framing, links to Archive. (First-time users panic at a naked strip; reassure.)
3. **Empty Archive:** *"Your future library."* + gentle first-park instruction. Never fake content.
4. **No search results:** widen scope visibly (W6 failure rule). Never a dead end.

## 5.10 Loading & AI states
AI regions show calm shimmer with factual microcopy ("naming…"), never fake certainty. If AI is degrading (slow/down), surfaces degrade to heuristics *without banners of alarm*; a discrete note in quiet page suffices.

## 5.11 Errors (error philosophy)
- Never blame the user. Never use the word "failed" about user content (use "couldn't secure / left open").
- Every error message carries the recovery path *in the same sentence.*
- Non-recoverable, user-content-affecting errors do not exist by design (Journal + snapshot-before-mutation invariant). Platform-level catastrophes disclose plainly what's guaranteed and what isn't.

## 5.12 Undo / Redo / Recovery
- Universal undo for every mutation (10s toast + ⌘Z in-project). Redo wherever redo is coherent (not for restores — reopening is idempotent anyway; state it).
- Undo is layered over Trash, which is layered over Sessions, over Exports: four safety nets, in that order of immediacy.

## 5.13 Accessibility (non-negotiables)
Everything keyboard-reachable and screen-reader-labeled · heartbeat uses polite live-region semantics · 200% zoom with zero loss of function · motion honors OS reduce-motion · confirmation thresholds tuned for panic, not confidence · copy standard: short sentences, no idioms, no exclamation marks, no shame. Accessibility is Commandment V's sibling: a product about anxiety must be operable while anxious.

---

# 6. AI BEHAVIOR

## 6.0 Constitutional rules for all AI
1. **Invisible.** No chat interface, no "ask me anything," no sparkle-wand theater. Users experience AI as *things already being right.*
2. **Proposes, never disposes.** AI may suggest, group, name, rank, summarize. It may never irreversibly act. Even "wrong-but-reversible" actions require the confidence bar in §6.12.
3. **Honest by design.** Every AI output carries internal confidence; low confidence renders as neutral/heuristic presentation ("saved 4:32 pm"), never as a guess wearing a lab coat.
4. **Correctable in one gesture, educated forever.** Corrections are first-class data (§6.13).
5. **Degradable.** With AI fully off (single global toggle per §6.14), the product remains coherent: heuristic names, time-clustered groups, keyword search.

## 6.1 Naming
- **Inputs:** tab titles/domains/paths within cluster; content if indexed (opt-in); user's vocabulary from Memory; time context.
- **Output:** 2–5 word mission name, human-plausible ("Schengen visa paperwork"), never generic ("Research session").
- **Failure:** confidence below bar → heuristic label ("12 tabs · docs & time-tracking · 4:32 pm"). Never ship a silly name with a straight face.
- **Privacy:** local-first model path; titles could leak into local processing only. **Control:** rename = instant + permanent; "don't auto-rename this mission again" via correction.

## 6.2 Grouping/Clustering
- **Inputs:** co-occurrence windows, domain/topic similarity, referrer chains (A opened from B), window membership, prior corrections.
- **Output:** mission assignments; drift suggestions ("this tab may not belong").
- **Failure:** mixed clusters default to larger, honest groups rather than precise wrong ones; never force-splits user-curated missions.
- **Control:** one-gesture move; "never group these domains" rule via menu.

## 6.3 Summarizing (mission & thread)
- **Inputs:** mission tabs' titles/URLs; indexed content (opt-in); session history of the mission.
- **Output:** one-liner (default surface) and full thread narrative at archive-time; regenerated on park, resume, archive, conclude.
- **Failure:** summarization skips gracefully — name + counts remain; no place-holder gibberish ("Summary unavailable" is honest and calm).
- **Privacy:** summaries about sensitive missions (medical, legal) remain local-only processing; cloud depth-mode (Ledge+) is opt-in **per category toggle**, with on-screen data-boundary labeling.

## 6.4 Memory (the learned layer)
- **Inputs:** corrections, usage rhythms (which missions open Monday 9am), vocabulary.
- **Output:** personalization of all other jobs; retrieval quality compounding.
- **Failure:** memory corruption → rebuild from Journal (derived, never primary). **Control:** "Forget everything" button (settings) — total Memory wipe, tabs untouched, disclosed plainly.

## 6.5 Duplicate detection
- **Inputs:** URL canonicalization (param stripping), title similarity, content hash if indexed.
- **Output:** markers + one-tap actions; "already kept" whispers (W11).
- **Failure:** false positive → permanent per-user whitelist, learned. No silent closing ever (marker + tap only).

## 6.6 Relationship discovery
- **Inputs:** topics, timestamps of co-activity, referrer chains across missions.
- **Output:** mission links ("related"), merge proposals with overlap evidence ("80% same domains"), shown as suggestions with confidence.
- **Failure:** bad merge suggestion → "dismiss" permanently, learned. Never auto-merges.

## 6.7 Project understanding (mission intelligence)
- **Inputs:** thread content + order + revisit patterns.
- **Output:** the mission's *thesis* in Memory: "evaluating CRMs under ₹2k/seat; criteria: import from Sheets, WhatsApp integration." Feeds briefs, search, archive Q&A (future).
- **Failure:** wrong thesis → briefs become generic (fail downward gracefully); correction on an outcome note reframes it.
- **Control:** outcome note (user-authored) outranks inferred thesis, always.

## 6.8 Search understanding
- **Inputs:** query text; corpus = open+kept+recently closed(+indexed content opt-in).
- **Output:** ranked results; semantic expansion in Ledge+ ("that retention article" → topic-matched pages even without keyword match).
- **Privacy:** free tier = local keyword/topic match; Ledge+ semantic = local embeddings where device supports, encrypted-cloud assist behind per-feature toggle. Content indexing is opt-in per site with a visible boundary ("index banking sites: never" default-denylist for financial/medical domains).
- **Failure:** semantic path down → keyword mode silently takes over; scope-widening rule applies (W6).

## 6.9 Context restoration (resumption briefs)
- **Inputs:** mission thesis, session diff since last open, last-active tab, scroll hints.
- **Output:** 2–3 sentence brief: state, where you stopped, what's pending.
- **Failure:** insufficient evidence → no brief (prefer absence to invention). **Control:** briefs dismissible per-mission-forever.

## 6.10 Intent prediction & recommendation timing
- **Inputs:** strip pressure (tab count trajectory), time-of-day rhythms, mission dormancy.
- **Output:** the single daily nudge at most ("6 tabs from last week's visa research — park them?"), morning card ranking, resumption surfacing.
- **Failure:** misfire → dismissal suppresses that nudge-type for 14 days (three dismissals = forever). Timing model errs to never. **Control:** one global "no suggestions" switch that still preserves crash-recovery (which is a promise, not a suggestion).

## 6.11 Confidence scoring (embedded in every job)
- Every AI artifact carries confidence ∈ {high, medium, low}; UI mapping: high = present normally · medium = present with "suggested" affordance · low = transform to neutral heuristic presentation. This scale is a product constant; no job may bypass it.

## 6.12 The action bar (what AI may do unilaterally)
- Allowed silently (reversible): group, name, summarize, rank, index (opt-in content), suggest.
- Never allowed silently (even high confidence): close/park tabs, delete anything, merge missions, change user-authored text, send anything off-device.
- Rule-derived actions (user-authored rules) still require the action to be undoable and announced after the fact ("Night rule parked 12 tabs — undo").

## 6.13 Correction learning
- **Inputs:** renames, moves, merges, splits, "not a duplicate"/"not related" dismissals, rule edits.
- **Outputs:** personalized vocabulary, grouping taste, similarity penalties for corrected pairs.
- **Guarantee:** a corrected decision is never silently re-litigated. (If world-state changes materially, AI may re-*suggest* once, framed as new information.)

## 6.14 Privacy & user control summary (all AI)
- Global AI-off switch; per-capability toggles (naming / clustering / summaries / semantic search / briefs / nudges).
- Data boundary: default local processing; cloud depth-mode (Ledge+) opt-in per category, with clear labeling at the moment of choice; no user data trains models; no third-party sharing of content — charter items, not settings whims.
- Explainability: every AI-made artifact answers "why" in one line on hover/long-press ("named from 6 tabs about Schengen forms").

---

# 7. THIRTY IMMUTABLE DESIGN PRINCIPLES

*Binding on every future feature, screen, and line of copy. Numbered for citation in reviews.*

1. **Never lose a thought.** Data loss is the only unforgivable sin.
2. **Closing is keeping.** Design every close to feel like progress.
3. **Zero gardening.** Organization is our job; correction is the user's one-gesture option.
4. **Felt, not seen.** No dashboard-as-destination; surfaces live at failure moments.
5. **Exit means export.** Open formats, one click, forever free.
6. **Trust before convenience.** When in doubt, choose the more explainable behavior.
7. **Silence over notifications.** Absence is a feature; every interruption must pay rent.
8. **Local-first, always.** The product works as designed with the network cable cut.
9. **The user's tabs are the user's.** Never touch them uninvited.
10. **Every destructive action is undoable; every unrecoverable action asks first.**
11. **Reassurance is information.** The heartbeat is data ("safe, as of 2 min ago"), not vibe.
12. **One container, many views.** Mission is the only container; Archive/History/Trash are lenses.
13. **AI is an organ, not a theater.** No chatbots, no sparkle-wand surfaces.
14. **AI proposes; the user disposes.** No irreversible AI action, at any confidence.
15. **When AI is unsure, it says so.** Confidence is rendered, not hidden.
16. **Correction is a gift.** One gesture to fix; permanent learning; never re-litigate silently.
17. **Name everything.** Nothing ships named "Untitled" or "Session 47."
18. **Resume the thought, not the URL.** Context over links, always.
19. **Search is a reflex, not a page.** One box, everywhere, unified scope.
20. **Defaults are decisions made well.** The best product needs the fewest settings.
21. **Settings exist for control, never to excuse weak defaults.**
22. **Calm copy only.** No exclamation marks, no urgency theater, no shame, no idioms.
23. **Performance is a trust feature.** A slow "safe" indicator is a lie in waiting.
24. **Every permission earns a one-sentence justification a frightened user accepts.**
25. **Design for the anxious closer first.** ADHD object-permanence and crash-trauma are primary constraints, not edge cases.
26. **No dark patterns.** No hostage pricing, no engagement bait, no artificial urgency.
27. **Delete before you add.** Every screen/feature must re-earn existence against the commandments at each major version.
28. **Import is as sacred as export.** Lock-in protection is reciprocal.
29. **Degrade gracefully.** AI off, sync off, cloud gone, ten years later: still coherent.
30. **The ten-year test.** Approve nothing you couldn't defend to a user in 2036.

---

# 8. MVP

## 8.1 MVP definition
**The smallest product that completes one full loop of the vision:** I can browse without fear, close without loss, get it back with meaning, find anything fast, and trust the system — alone, on one device, without AI magic being load-bearing.

## 8.2 What STAYS (and why each is vision-load-bearing)
1. **Journal + crash recovery (W7)** — Commandment I. The witnessing moment is the product's origin story.
2. **Park in 4 granularities, snapshot-before-close invariant (W4)** — Commandment II.
3. **Missions: auto-clustered + auto-named (W2/W3, heuristics-first)** — Commandment III, minimal viable gardening-elimination.
4. **Restore/reopen (W5, clean restore; briefs deferred)** — the payoff of parking.
5. **Reflex Search v1 (⌘⇧K; unified open/kept/closed; keyword+topic)** — Commandment IV's sense organ.
6. **Safety heartbeat** — the designed affect; ADHD-critical.
7. **Recently Closed + Trash + universal Undo** — the four safety nets minus Session history.
8. **Export (HTML/JSON/MD) + Import (OneTab/SessionBuddy/bookmarks)** — Commandment V and the refugee funnel, both day-one marketing assets.
9. **The three empty states + calm copy standard** — emotion is the product.
10. **Core accessibility set** (§4.5) and **quiet page v1** (missions, archive, closed, trash, settings).

## 8.3 What is REMOVED from consideration at MVP (re-evaluated per version)
- Nothing from the vision is "removed" permanently; see postponements. From the *candidate* feature pool, MVP removes all §4.6 Future items and every §4.4 P3 nicety.

## 8.4 What is POSTPONED (with rationale & target)
| Postponed | To | Why it can wait without breaking the loop |
|---|---|---|
| Resumption briefs + morning card | v1.1–v1.2 | Vision's differentiator, but requires summary quality the MVP grows into; restoring *reliably* must precede restoring *eloquently* |
| Switcher (atomic park+switch) | v1.1 | Depends on park/restore being battle-proven |
| Duplicate intelligence | v1.1 | Needs canonicalization correctness; false positives early would burn trust |
| Topics chips | v1.1 | Retrieval metadata; search v1 suffices |
| Sprawl nudge + timing model | v1.1 | Silence must be earned; ship quiet first, then whisper |
| Command-palette door, power filters | v1.1/v1.2 | Power layer atop proven basics |
| E2E Sync (Ledge+) | v2 | Revenue pillar; demands the Journal merge logic be trustworthy — trust is earned on one device first |
| Session timeline ("see mission on June 3") | v2 | Deep-trust feature riding on snapshot volume |
| Rules (scheduled park prompts) | v2 | Requires the §6.12 action bar to be respected culturally first |
| Share session as link/file | v2 | Viral loop; matters more at credibility scale |
| Semantic search + content indexing (Ledge+) | v2 | Boundary engineering must be flawless; keyword must delight first |
| Archive conclude + outcome notes | v1.2 | Quick win right after MVP cements archive habit |

## 8.5 MVP exit criteria (product, not engineering)
- A crash can be induced and the user loses nothing, provably, with a calm banner (W7).
- Parking 100 tabs and restoring them works with the snapshot-before-close invariant (W4/W5).
- Search returns a correct item from each scope in ≤2 keystrokes-worth of effort (W6).
- Export file opened in a fresh browser needs no Ledge to be readable (W14).
- All §7 principles pass review on every shipped surface (checklist).

---

# 9. PRODUCT REVIEW (adversarial audit of THIS specification)

*Method: attempt to violate each commandment with each section; hunt contradictions, overlaps, and creep; simplify.*

## 9.1 Contradictions found & resolved
1. **Vision listed "Done" as a lifecycle state; §1.3.2 folds it into ARCHIVED with a `concluded` flag.** *Resolution:* three states + one flag carries the same meaning with 25% less state machinery. The satisfying closure gesture is preserved. **Fold-in ratified.**
2. **Vision granted "scheduled auto-park"; Principle 9 forbids touching tabs uninvited.** *Resolution:* rules never auto-close. A scheduled rule produces a same-moment, user-authored-context prompt; auto-execution allowed only for *parking* (fully reversible, snapshot-first) with mandatory after-the-fact undoable notice (§6.12). Auto-closing anything else: forbidden even by rule.
3. **Heartbeat (always visible) vs. Silence (Principle 7).** *Resolution:* heartbeat is passive state, not an interruption; it occupies the same informational class as a clock. Ratified, and clarified §5.8 (heartbeat ≠ notification).
4. **"Memory" appeared object-like in early drafts; users might expect to browse it.** *Resolution:* Memory is internal-only; everything user-meaningful renders through missions, summaries, topics, search (§1.3.5). Prevents a phantom seventh surface.
5. **Command palette vs. Reflex Search = overlapping mechanisms.** *Resolution:* one search engine, two doors: default scope "things," verb-prefix scope "commands." One mental model retained (§5.4).
6. **Cross-device "resume open tabs" threatened Principle 9 across device boundaries.** *Resolution (W10):* sync surfaces other devices' open state as *information*; takeover of live tabs is future-scope and would require its own review. Current canon: resume parked/archived only.

## 9.2 Unnecessary complexity removed
- **Workspace/Folder/Collection/Project objects:** deleted (§1.1) — biggest simplification in the spec; kills an entire class of gardening UI and sync-merge edge cases.
- **Per-Session user management** (rename/delete individual snapshots): removed; sessions are read-only and age automatically. One control plane fewer.
- **Multi-membership of tabs:** rejected (§3.3) in favor of links + search.
- **Auto-export scheduling:** rejected (§4.4) — silent background file writes are unexplainable to a frightened user (Principle 24).
- **Settings audit:** every proposed setting was challenged by Principle 21; survivors are retention window, AI toggles, shortcuts, nudge opt-outs, "forget everything." 

## 9.3 Overlaps de-duplicated
"History" vs Recently Closed (merged into one concept, §3.9) · "Bookmark" import target vs Mission (import *becomes* missions; no parallel store) · Summary vs Brief (one summary object, two renderings: short on park, long at archive/resume).

## 9.4 Philosophy-violation scan (result)
✅ No notifications beyond §5.8 classes. ✅ No container besides Mission. ✅ No chatbot-shaped AI. ✅ No hostage mechanic (Recently-Closed retention *depth* is paid in Ledge+; deliberately parked content is unlimited-free — access is never sold, depth is). ✅ No uninvited lifecycle moves. ✅ No social/graph objects. ✅ "Ask-the-archive" remains Future and scoped.

## 9.5 Scope-creep audit
Four features labeled v2 carry the highest creep gravity (Sync, Share links, Semantic search, Rules). Rule: no v2 item starts before its MVP-vintage subsystem passes a trust audit (e.g., Share requires Export to have been stable; Sync requires Journal-merge proofs). Creep control is staged by *dependency on earned trust*, not by enthusiasm.

## 9.6 Final simplification pass (net change to spec)
- User-facing concept count: **6** (Tab, Mission, Recently Closed, Archive, Trash, Search) — Session read-only-adjacent, Journal & Memory internal.
- Surfaces: **3**. MVP workflows that must be flawless: **W1, W2, W4, W5, W6, W7, W13, W14, W15** — nine. Everything else is subsequent.
- The MVP thus ships **one loop, four safety nets, three surfaces, two import/export doors, zero accounts, zero notifications.**

---

# 10. FINAL OUTPUT — HANDOFF SUMMARY (the canon in one page)

**Product:** Ledge — an AI-powered tab & mission manager whose currency is trust and whose emotion is relief.

**Promise:** Never lose a thought. **Loop:** Open → Park → Resume → Find → Archive.

**Canon decisions (non-negotiable):**
1. Six user concepts: Tab, Mission, Recently Closed, Archive, Trash, Search. Internals: Journal, Memory, Session.
2. Two-level hierarchy, one container (Mission), views for everything else. No folders. No workspaces.
3. Mission states: OPEN ⇄ PARKED ⇄ ARCHIVED (+concluded flag). Tabs: LIVE ⇄ KEPT → Trash → purge.
4. Snapshot-before-close invariant: no park proceeds without a completed snapshot.
5. Journal is canonical; local-first; sync (v2) is E2E replica only. Derived Memory dies with its source.
6. Search: one reflex box across open/kept/closed/(opt-in) content; keyword-first, semantic later, scope-widening never a dead end.
7. AI constitution: invisible · proposes-never-disposes · confidence-rendered · one-gesture-correctable · globally switchable · local-first processing with explicitly labeled depth cloud opt-in.
8. Notifications: crash-recovery + one-optional-nudge/day + actionable-sync-notices. Heartbeat is passive state, not notification.
9. Access is never sold. Free: unlimited local keep/restore/search/export. Ledge+: sync, AI depth, memory depth, rules.
10. Nine flawless MVP workflows; everything else staged behind earned trust.
11. Thirty principles govern all future work (§7); the five commandments govern this document.

**Success feels like:** a user closing 150 tabs and smiling; a crash that becomes a non-event; a Monday that remembers Friday; a three-year archive answered in seconds — and the sentence we exist to overhear: *"I don't worry about my browser anymore. I have an archive."*

*Specification ends. The next sanctioned document is the MVP UX Specification (screens, states, microcopy) drawn exclusively from §2, §5 and §8.2 of this canon.*
