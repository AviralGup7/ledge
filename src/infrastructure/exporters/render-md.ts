// E5-T03 · render-md (ADR-045: notes-style). Markdown link grammar
// (- [title](url)); escaping law: markdown specials in titles are escaped so a
// hostile title cannot fabricate structure ([ ] \ and newline runs flattened).
import type { CanonicalExportModel, ExportTabModel } from './model.js';
import type { RawPart } from './stream.js';

/** Mission sections per part (streaming granularity). */
export const MD_SECTION_BATCH = 200;

const escapeMdText = (raw: string): string =>
  raw
    .replace(/\s+/g, ' ')
    .replaceAll('\\', '\\\\')
    .replaceAll('[', '\\[')
    .replaceAll(']', '\\]')
    .trim();

const escapeMdUrl = (raw: string): string =>
  raw.replace(/\s+/g, '%20').replaceAll('(', '%28').replaceAll(')', '%29');

const tabLine = (t: ExportTabModel): string =>
  `- [${escapeMdText(t.title.length > 0 ? t.title : t.url)}](${escapeMdUrl(t.url)})`;

const missionText = (mission: CanonicalExportModel['missions'][number]): string =>
  `## ${escapeMdText(mission.name)} (${String(mission.tabs.length)})\n\n${mission.tabs
    .map(tabLine)
    .join('\n')}\n\n`;

const headText = (model: CanonicalExportModel): string => {
  const generated = new Date(model.generatedAt).toISOString();
  return (
    `# ${model.app.name} export\n\n` +
    `> format ${model.format} v${String(model.formatV)} · build ${model.app.build} · canonRulesV ${String(
      model.canonRulesV,
    )} · generated ${generated}\n\n`
  );
};

const looseText = (model: CanonicalExportModel): string =>
  model.looseTabs.length === 0
    ? ''
    : `## Loose tabs (${String(model.looseTabs.length)})\n\n${model.looseTabs
        .map(tabLine)
        .join('\n')}\n`;

/** Build the notes-style markdown's raw parts (deterministic). */
export const mdParts = (model: CanonicalExportModel): readonly RawPart[] => {
  const parts: RawPart[] = [{ partId: 'head', text: headText(model) }];
  for (let start = 0; start < model.missions.length; start += MD_SECTION_BATCH) {
    const batch = model.missions.slice(start, start + MD_SECTION_BATCH);
    parts.push({
      partId: `missions:${String(Math.floor(start / MD_SECTION_BATCH))}`,
      text: batch.map(missionText).join(''),
    });
  }
  parts.push({ partId: 'tail', text: looseText(model) });
  return parts;
};
