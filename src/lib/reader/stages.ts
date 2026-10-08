// Pipeline stage reporting.
//
// Every document — benchmark or not — runs the same ten stages. This module
// turns the artefacts of each stage into an explicit, machine-readable report
// so a document is only ever called "ready" on evidence, never because a
// parser happened to emit some text.

import type { Line } from "./lines";
import type { DocProfile, PageLines } from "./layout";
import type { Block, RawDoc, RefEdge, RefSystem, StructureNode } from "./types";
import { UNDECODABLE } from "./unicode";

export type StageId =
  | "extraction"
  | "font-unicode"
  | "geometry"
  | "reading-order"
  | "structure"
  | "text-normalization"
  | "reference-extraction"
  | "reference-classification"
  | "reference-resolution"
  | "artifact";

export type StageStatus = "ok" | "warn" | "failed" | "skipped";

export interface StageReport {
  id: StageId;
  label: string;
  status: StageStatus;
  metrics: Record<string, number>;
  notes: string[];
}

export type IssueCode =
  | "extraction-failure"
  | "ocr-required"
  | "low-ocr-confidence"
  | "malformed-fonts"
  | "unsupported-pdf-structure"
  | "structure-detection-failure"
  | "unresolved-references"
  | "ambiguous-references"
  | "unsupported-reference-system";

export interface Issue {
  code: IssueCode;
  severity: "error" | "warn" | "info";
  stage: StageId;
  message: string;
}

export type Readiness = "ready" | "degraded" | "unreadable";

export interface PipelineReport {
  readiness: Readiness;
  stages: StageReport[];
  issues: Issue[];
}

/** An apparatus candidate the detector saw but refused to accept as a system. */
export interface RejectedSystem {
  label: string;
  reason: string;
}

export interface StageInput {
  raw: RawDoc;
  pages: PageLines[];
  profile: DocProfile;
  dropped: number;
  blocks: Block[];
  structure: StructureNode[];
  systems: RefSystem[];
  entryCount: number;
  refs: RefEdge[];
  rejected: RejectedSystem[];
}

const pct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 1000) / 10 : 0);

export function assessPipeline(input: StageInput): PipelineReport {
  const { raw, pages, profile, blocks, structure, systems, refs, rejected } = input;
  const issues: Issue[] = [];
  const stages: StageReport[] = [];
  const add = (s: StageReport) => stages.push(s);

  // --- 1. raw extraction ----------------------------------------------------
  const pageCount = raw.pages.length || raw.pageCount;
  const items = raw.pages.reduce((a, p) => a + p.items.length, 0);
  const chars = raw.pages.reduce((a, p) => a + p.items.reduce((b, i) => b + i.t.length, 0), 0);
  const pagesWithText = raw.pages.filter((p) => p.items.length > 0).length;
  const textCoverage = pct(pagesWithText, pageCount);
  const linkCount = raw.pages.reduce((a, p) => a + p.links.length, 0);

  // Ingestion method mix. A page is native, OCR'd or genuinely empty; the rest
  // of the pipeline treats all three identically, the diagnostics do not.
  const ocrPagesArr = raw.pages.filter((p) => p.method === "ocr");
  const nativePages = raw.pages.filter((p) => (p.method ?? (p.items.length ? "native" : "empty")) === "native").length;
  const ocrCount = ocrPagesArr.length;
  const ocrFailed = ocrPagesArr.filter((p) => p.ocr?.error || p.items.length === 0).length;
  const ocrWords = ocrPagesArr.reduce((a, p) => a + (p.ocr?.words ?? 0), 0);
  const ocrLow = ocrPagesArr.reduce((a, p) => a + (p.ocr?.lowConfidenceWords ?? 0), 0);
  const ocrConf =
    ocrCount > 0
      ? Math.round((ocrPagesArr.reduce((a, p) => a + (p.ocr?.meanConfidence ?? 0), 0) / ocrCount) * 1000) / 1000
      : 0;
  const kind = ocrCount === 0 ? (nativePages ? "native-text" : "empty") : nativePages ? "mixed" : "scanned";

  let extraction: StageStatus = "ok";
  const exNotes: string[] = [
    `document classified as ${kind}: ${nativePages} native-text page(s), ${ocrCount} OCR'd page(s)`,
    `${items} positioned text items across ${pageCount} pages`,
    `${linkCount} link annotations, ${raw.outline.length} outline entries`,
  ];
  if (ocrCount > 0) {
    exNotes.push(
      `OCR recovered ${ocrWords} words at mean confidence ${ocrConf}; ${ocrLow} word(s) below 0.6`,
    );
  }
  if (items === 0) {
    extraction = "failed";
    issues.push({
      code: "extraction-failure",
      severity: "error",
      stage: "extraction",
      message: "No text could be extracted from this PDF: neither a text layer nor OCR produced any words.",
    });
    if (ocrCount > 0 || raw.pages.some((p) => p.method === "empty")) {
      issues.push({
        code: "ocr-required",
        severity: "error",
        stage: "extraction",
        message: "The file appears to be page images and OCR produced nothing usable.",
      });
    }
  } else if (textCoverage < 50) {
    extraction = "failed";
    issues.push({
      code: "ocr-required",
      severity: "error",
      stage: "extraction",
      message: `Only ${textCoverage}% of pages yielded text (${pagesWithText}/${pageCount}); the rest are images OCR could not read.`,
    });
  } else if (textCoverage < 92) {
    extraction = "warn";
    issues.push({
      code: "ocr-required",
      severity: "warn",
      stage: "extraction",
      message: `${pageCount - pagesWithText} page(s) produced no text and will read as gaps.`,
    });
  }
  if (ocrFailed > 0 && items > 0) {
    extraction = extraction === "ok" ? "warn" : extraction;
    issues.push({
      code: "ocr-required",
      severity: "warn",
      stage: "extraction",
      message: `${ocrFailed} scanned page(s) failed OCR and contribute no text.`,
    });
  }
  if (ocrCount > 0 && ocrConf > 0 && ocrConf < 0.75) {
    extraction = extraction === "ok" ? "warn" : extraction;
    // Weak OCR only makes a book unreadable when the book actually depends on
    // it. A handful of plates in an otherwise native-text edition is a note,
    // not a failure.
    const share = raw.pageCount > 0 ? ocrCount / raw.pageCount : 1;
    issues.push({
      code: "low-ocr-confidence",
      severity: ocrConf < 0.6 && share >= 0.2 ? "error" : "warn",
      stage: "extraction",
      message: `OCR confidence averages ${ocrConf} across ${ocrCount} scanned page(s); the reading text may be corrupted.`,
    });
  }
  add({
    id: "extraction",
    label: "Raw extraction",
    status: extraction,
    metrics: {
      pages: pageCount,
      items,
      characters: chars,
      pagesWithText,
      textCoveragePct: textCoverage,
      links: linkCount,
      nativePages,
      ocrPages: ocrCount,
      emptyPages: pageCount - nativePages - ocrCount,
      ocrFailedPages: ocrFailed,
      ocrWords,
      ocrMeanConfidence: ocrConf,
      ocrLowConfidenceWords: ocrLow,
      ocrPagesSharePct: pct(ocrCount, pageCount),
    },
    notes: exNotes,
  });

  const dead = extraction === "failed";
  const skip = (id: StageId, label: string, metrics: Record<string, number> = {}): StageReport => ({
    id,
    label,
    status: "skipped",
    metrics,
    notes: ["skipped: extraction produced no usable text"],
  });

  // --- 2. font / unicode normalization -------------------------------------
  if (dead) add(skip("font-unicode", "Font & Unicode normalization"));
  else {
    let bad = 0;
    let sc = 0;
    for (const p of raw.pages)
      for (const i of p.items) {
        if (i.sc) sc++;
        for (const ch of i.t) if (UNDECODABLE.test(ch)) bad++;
      }
    const badPct = pct(bad, chars);
    let status: StageStatus = "ok";
    if (badPct > 2) {
      status = "failed";
      issues.push({
        code: "malformed-fonts",
        severity: "error",
        stage: "font-unicode",
        message: `${badPct}% of characters have no Unicode mapping and could not be recovered from glyph codes.`,
      });
    } else if (bad > 0) {
      status = "warn";
      issues.push({
        code: "malformed-fonts",
        severity: "warn",
        stage: "font-unicode",
        message: `${bad} character(s) remain undecodable after glyph recovery.`,
      });
    }
    add({
      id: "font-unicode",
      label: "Font & Unicode normalization",
      status,
      metrics: { undecodableChars: bad, undecodablePct: badPct, smallCapsSpansRecovered: sc },
      notes: [
        sc ? `${sc} span(s) recovered from fonts with no Unicode map` : "no unmapped fonts needed recovery",
        "NFC normalization and ligature expansion applied to every span",
      ],
    });
  }

  // --- 3. page geometry -----------------------------------------------------
  const allLines: Line[] = pages.flatMap((p) => p.lines);
  if (dead) add(skip("geometry", "Page geometry"));
  else {
    const brokenPages = raw.pages.filter((p) => p.items.length > 3 && (pages.find((q) => q.page === p.page)?.lines.length ?? 0) === 0);
    let status: StageStatus = "ok";
    if (brokenPages.length > 0) {
      status = "warn";
      issues.push({
        code: "unsupported-pdf-structure",
        severity: brokenPages.length > pageCount * 0.1 ? "error" : "warn",
        stage: "geometry",
        message: `${brokenPages.length} page(s) produced text items no line clustering could group (rotated or vector-laid-out text).`,
      });
    }
    const sizes = new Set(raw.pages.map((p) => `${Math.round(p.width)}x${Math.round(p.height)}`));
    add({
      id: "geometry",
      label: "Page geometry",
      status,
      metrics: {
        lines: allLines.length,
        bodySize: profile.bodySize,
        leading: profile.leading,
        proseLeft: profile.proseLeft,
        paraIndent: profile.paraIndent,
        pageSizeVariants: sizes.size,
        unclusteredPages: brokenPages.length,
      },
      notes: [
        `body text measured at ${profile.bodySize}pt, leading ${profile.leading}`,
        `${sizes.size} distinct page size(s)`,
      ],
    });
  }

  // --- 4. reading-order reconstruction -------------------------------------
  if (dead) add(skip("reading-order", "Reading order"));
  else {
    const furniture = input.dropped;
    const kept = allLines.length - furniture;
    let status: StageStatus = "ok";
    const notes = [
      `${furniture} line(s) dropped as running heads/feet or page furniture`,
      `${blocks.length} blocks built from ${kept} content lines`,
    ];
    if (blocks.length === 0) {
      status = "failed";
      issues.push({
        code: "unsupported-pdf-structure",
        severity: "error",
        stage: "reading-order",
        message: "Text was extracted but no reading blocks could be assembled from it.",
      });
    } else if (kept > 0 && blocks.length / Math.max(1, kept) > 0.9) {
      status = "warn";
      notes.push("almost every line became its own block — paragraph joining may have failed");
    }
    add({
      id: "reading-order",
      label: "Reading order",
      status,
      metrics: { blocks: blocks.length, furnitureDropped: furniture, contentLines: kept },
      notes,
    });
  }

  // --- 5. structure detection ----------------------------------------------
  if (dead) add(skip("structure", "Document structure"));
  else {
    const sections = Math.max(0, structure.length - 1);
    const headings = blocks.filter((b) => b.type === "heading").length;
    let status: StageStatus = "ok";
    if (sections === 0 && pageCount > 15) {
      status = "failed";
      issues.push({
        code: "structure-detection-failure",
        severity: "error",
        stage: "structure",
        message: "No divisions (parts, chapters, sections) were detected; the document will read as one undifferentiated run.",
      });
    } else if (sections < 3 && pageCount > 80) {
      status = "warn";
      issues.push({
        code: "structure-detection-failure",
        severity: "warn",
        stage: "structure",
        message: `Only ${sections} division(s) detected across ${pageCount} pages — headings may be going unrecognised.`,
      });
    }
    add({
      id: "structure",
      label: "Document structure",
      status,
      metrics: { sections, headings, outlineEntries: raw.outline.length },
      notes: [
        raw.outline.length ? "PDF outline present and merged with page headings" : "no PDF outline — structure inferred from typography alone",
      ],
    });
  }

  // --- 6. text normalization ------------------------------------------------
  if (dead) add(skip("text-normalization", "Text normalization"));
  else {
    const glued = blocks.filter((b) => /[a-z]{2}[.,;!?”][A-Za-z]/.test(b.text)).length;
    const residue = blocks.filter((b) => UNDECODABLE.test(b.text)).length;
    const hyphens = blocks.filter((b) => /\w-\s\w/.test(b.text)).length;
    const status: StageStatus = residue > 0 || glued > blocks.length * 0.01 ? "warn" : "ok";
    add({
      id: "text-normalization",
      label: "Text normalization",
      status,
      metrics: { blocks: blocks.length, gluedPunctuation: glued, undecodableBlocks: residue, suspectHyphenation: hyphens },
      notes: [
        glued ? `${glued} block(s) still show punctuation glued to the next word` : "no glued punctuation detected",
        "soft hyphens rejoined, spaces reconstructed from advance widths",
      ],
    });
  }

  // --- 7/8. reference extraction & classification ---------------------------
  if (dead) {
    add(skip("reference-extraction", "Reference extraction"));
    add(skip("reference-classification", "Reference classification"));
    add(skip("reference-resolution", "Reference resolution"));
  } else {
    const explicit = refs.filter((r) => r.provenance === "explicit-link").length;
    add({
      id: "reference-extraction",
      label: "Reference extraction",
      status: "ok",
      metrics: { systems: systems.length, entries: input.entryCount, candidates: refs.length, explicitLinks: explicit },
      notes: systems.length
        ? systems.map((s) => `${s.label}: ${s.kind}/${s.grammar}, ${s.entryCount} entries`)
        : ["no editorial apparatus found — this document simply has no reference system"],
    });

    let clsStatus: StageStatus = "ok";
    for (const r of rejected) {
      clsStatus = "warn";
      issues.push({
        code: "unsupported-reference-system",
        severity: "warn",
        stage: "reference-classification",
        message: `"${r.label}" looks like an apparatus but no system could be modelled from it: ${r.reason}`,
      });
    }
    const byType: Record<string, number> = {};
    for (const r of refs) byType[r.type] = (byType[r.type] ?? 0) + 1;
    add({
      id: "reference-classification",
      label: "Reference classification",
      status: clsStatus,
      metrics: byType,
      notes: [
        `${Object.keys(byType).length} reference type(s) in use`,
        `${explicit} explicit PDF link(s), ${refs.length - explicit} inferred`,
        rejected.length ? `${rejected.length} apparatus candidate(s) rejected` : "no apparatus candidate rejected",
      ],
    });

    // --- 9. resolution ------------------------------------------------------
    const resolved = refs.filter((r) => r.to || r.toSection).length;
    const ambiguous = refs.filter((r) => r.ambiguous).length;
    const unresolved = refs.length - resolved;
    const rate = pct(resolved, refs.length);
    let status: StageStatus = "ok";
    if (refs.length > 0 && rate < 60) {
      // Poor resolution degrades the reference graph, not the reading text:
      // a novel whose only "references" are inferred cross-mentions is still a
      // perfectly readable book.
      status = "failed";
      issues.push({
        code: "unresolved-references",
        severity: "warn",
        stage: "reference-resolution",
        message: `Only ${rate}% of detected references resolve to a target (${resolved}/${refs.length}).`,
      });
    } else if (unresolved > 0) {
      status = "warn";
      issues.push({
        code: "unresolved-references",
        severity: "warn",
        stage: "reference-resolution",
        message: `${unresolved} reference(s) could not be resolved to a target.`,
      });
    }
    if (ambiguous > 0) {
      status = status === "failed" ? status : "warn";
      issues.push({
        code: "ambiguous-references",
        severity: "warn",
        stage: "reference-resolution",
        message: `${ambiguous} reference(s) had more than one plausible target and were left ambiguous.`,
      });
    }
    add({
      id: "reference-resolution",
      label: "Reference resolution",
      status,
      metrics: { total: refs.length, resolved, unresolved, ambiguous, resolvedPct: rate },
      notes: refs.length ? [`${rate}% resolved`] : ["nothing to resolve"],
    });
  }

  // --- 10. artifact ---------------------------------------------------------
  // "Unreadable" is reserved for documents whose *text* could not be recovered.
  const readiness: Readiness = issues.some((i) => i.severity === "error")
    ? "unreadable"
    : issues.some((i) => i.severity === "warn")
      ? "degraded"
      : "ready";
  add({
    id: "artifact",
    label: "Normalized artifact",
    status: readiness === "unreadable" ? "failed" : readiness === "degraded" ? "warn" : "ok",
    metrics: { blocks: blocks.length, sections: Math.max(0, structure.length - 1), refs: refs.length },
    notes: [
      readiness === "ready"
        ? "every stage passed; the normalized document is trustworthy"
        : readiness === "degraded"
          ? "readable, but some stages reported problems — see issues"
          : "this document cannot be read reliably; it is not a usable reading artifact",
    ],
  });

  return { readiness, stages, issues };
}
