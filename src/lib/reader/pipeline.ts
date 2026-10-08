import { detectApparatus } from "./apparatus";
import { buildContent } from "./content";
import { detectPageNotes } from "./footnotes";
import { layoutPages } from "./layout";
import { buildReferences } from "./references";
import { assessPipeline } from "./stages";
import type { DocumentModel, RawDoc, RefSystem } from "./types";

/**
 * The one and only import pipeline.
 *
 * PDF -> raw extraction -> font/Unicode normalization -> page geometry ->
 * reading-order reconstruction -> structure detection -> text normalization ->
 * reference extraction -> classification -> resolution -> artifact.
 *
 * Every stage is format- and document-agnostic: nothing here knows which book
 * it is reading, and every decision is taken from evidence in the file itself.
 * Each stage reports what it saw, so a document is only ever "ready" when the
 * evidence says so.
 */
export function analyze(raw: RawDoc, id: string): DocumentModel {
  const { pages, profile, dropped, removed, pageMap } = layoutPages(raw);
  const { blocks, structure, verseSections, repairedTokens, embedded } = buildContent(raw, pages, profile);
  const { systems, entries, rejected } = detectApparatus(blocks, structure, verseSections > 0);
  const pageNotes = detectPageNotes(blocks, structure, systems.length);
  systems.push(...pageNotes.systems);
  entries.push(...pageNotes.entries);

  if (verseSections > 0) {
    const sample = blocks.find((b) => b.type === "verse-line" && (b.line ?? 0) > 1);
    systems.unshift({
      id: "sys-lines",
      kind: "line-numbering",
      label: "Verse lineation",
      grammar: "line-keyed",
      keyScope: "book",
      hosts: structure.filter((s) => s.verse).map((s) => s.id),
      typography: { size: profile.bodySize, indent: profile.bodyIndent, leading: profile.leading, altFontLemma: false },
      entryCount: blocks.filter((b) => b.type === "verse-line").length,
      evidence: [
        `${verseSections} sections set as verse (short measures, marginal numerals)`,
        "numbers sit outside the text block and were removed from the reading text",
      ],
      confidence: 0.95,
      samples: sample ? [{ key: String(sample.line), text: sample.text.slice(0, 120) }] : [],
    } satisfies RefSystem);
  }

  const linkCount = raw.pages.reduce((a, p) => a + p.links.length, 0);
  if (linkCount > 0) {
    systems.push({
      id: "sys-links",
      kind: "internal-link",
      label: "Embedded PDF links",
      grammar: "none",
      keyScope: "document",
      hosts: [],
      typography: { size: 0, indent: 0, leading: 0, altFontLemma: false },
      entryCount: linkCount,
      evidence: [`${linkCount} link annotations in the source file`],
      confidence: 1,
      samples: [],
    });
  }

  const links = raw.pages.flatMap((p) => p.links.map((l) => ({ ...l, page: p.page })));
  const { refs, unresolved, recognition, census } = buildReferences(blocks, structure, systems, entries, { links, pageMap });

  const counts: Record<string, number> = {};
  for (const r of refs) counts[r.type] = (counts[r.type] ?? 0) + 1;
  counts["blocks"] = blocks.length;
  counts["sections"] = structure.length - 1;
  counts["entries"] = entries.length;
  counts["resolved"] = refs.filter((r) => r.to || r.toSection).length;
  counts["explicitLinks"] = refs.filter((r) => r.provenance === "explicit-link").length;
  counts["candidatesRejected"] = recognition.filter((r) => r.decision === "rejected").length;
  counts["candidatesMerged"] = recognition.filter((r) => r.decision === "merged").length;


  const report = assessPipeline({
    raw,
    pages,
    profile,
    dropped,
    blocks,
    structure,
    systems,
    entryCount: entries.length,
    refs,
    rejected,
  });

  return {
    id,
    title: raw.meta.title?.trim() || "Untitled",
    author: raw.meta.author?.trim() || null,
    pageCount: raw.pageCount,
    structure,
    blocks,
    systems,
    refs,
    diagnostics: {
      bodySize: profile.bodySize,
      bodyIndent: profile.bodyIndent,
      droppedFurniture: dropped,
      verseSections,
      unresolved: unresolved.slice(0, 200),
      counts,
      pageMap,
      removedTokens: removed.slice(0, 400),
      repairedTokens: repairedTokens.slice(0, 200),
      embedded,
      readiness: report.readiness,

      stages: report.stages,
      issues: report.issues,
      // capped: the full log of a large book is diagnostic, not reading data
      recognition: recognition.slice(0, 4000),
      referenceSystems: census.profiles,
    },
  };
}
