// E5-T03 · render-html (ADR-045: standalone, self-contained, opens anywhere, no
// external assets — EES §12 AC: "HTML renders standalone offline from export
// alone"). Inline styles only; NO scripts, fonts, images, or external refs of any
// kind (anchors carry the exported URLs as DATA links — user-invoked, never
// auto-fetched). Escaping law: every model string passes escapeHtml (text) —
// a hostile title must never break the document's structure.
import type { CanonicalExportModel } from './model.js';
import type { RawPart } from './stream.js';

/** Mission sections per part (streaming granularity; html has one 'head'/'tail'). */
export const HTML_SECTION_BATCH = 100;

const escapeHtml = (raw: string): string =>
  raw
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

const STYLE = [
  'body{font-family:ui-sans-serif,system-ui,sans-serif;max-width:52rem;margin:2rem auto;padding:0 1rem;color:#1a1a1a;line-height:1.5}',
  'h1{font-size:1.4rem}h2{font-size:1.1rem;margin-top:2rem;border-bottom:1px solid #ddd;padding-bottom:.2rem}',
  'ol{padding-left:1.4rem}li{margin:.25rem 0}a{color:#0645ad;text-decoration:none}a:hover{text-decoration:underline}',
  '.meta{color:#666;font-size:.85rem}.count{color:#666;font-weight:400}',
].join('\n');

const headText = (model: CanonicalExportModel): string => {
  const generated = new Date(model.generatedAt).toISOString();
  const title = `${escapeHtml(model.app.name)} export`;
  return (
    `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">\n` +
    `<title>${title}</title>\n<style>\n${STYLE}\n</style>\n</head>\n<body>\n` +
    `<h1>${title}</h1>\n` +
    `<p class="meta">format ${escapeHtml(model.format)} v${String(model.formatV)} · build ${escapeHtml(model.app.build)} · canonRulesV ${String(model.canonRulesV)} · generated ${escapeHtml(generated)}</p>\n`
  );
};

const missionText = (mission: CanonicalExportModel['missions'][number]): string => {
  const items = mission.tabs
    .map(
      (t) =>
        `<li><a href="${escapeHtml(t.url)}">${escapeHtml(t.title.length > 0 ? t.title : t.url)}</a> <span class="meta">${escapeHtml(t.domain)}</span></li>`,
    )
    .join('\n');
  return (
    `<section>\n<h2>${escapeHtml(mission.name)} ` +
    `<span class="count">(${String(mission.tabs.length)})</span></h2>\n` +
    `<ol>\n${items}\n</ol>\n</section>\n`
  );
};

const looseText = (model: CanonicalExportModel): string => {
  if (model.looseTabs.length === 0) return '';
  const items = model.looseTabs
    .map(
      (t) =>
        `<li><a href="${escapeHtml(t.url)}">${escapeHtml(t.title.length > 0 ? t.title : t.url)}</a> <span class="meta">${escapeHtml(t.domain)}</span></li>`,
    )
    .join('\n');
  return (
    `<section>\n<h2>Loose tabs <span class="count">(${String(model.looseTabs.length)})</span></h2>\n` +
    `<ol>\n${items}\n</ol>\n</section>\n`
  );
};

/** Build the standalone HTML document's raw parts (deterministic). */
export const htmlParts = (model: CanonicalExportModel): readonly RawPart[] => {
  const parts: RawPart[] = [{ partId: 'head', text: headText(model) }];
  for (let start = 0; start < model.missions.length; start += HTML_SECTION_BATCH) {
    const batch = model.missions.slice(start, start + HTML_SECTION_BATCH);
    parts.push({
      partId: `missions:${String(Math.floor(start / HTML_SECTION_BATCH))}`,
      text: batch.map(missionText).join(''),
    });
  }
  parts.push({ partId: 'tail', text: `${looseText(model)}</body>\n</html>\n` });
  return parts;
};
