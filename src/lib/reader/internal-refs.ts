// Semantic internal references without a hyperlink.
//
// Runs on NORMALIZED block text only (PDF line breaks are already folded away)
// and resolves against the normalized structure, captions, apparatus entries,
// verse line numbers and the printed-page map — never raw PDF coordinates.
//
// Central rule: a phrase that merely *looks* like a reference is not one. An
// expression becomes a reference only on evidence that it points somewhere:
//   - an explicit referring cue ("see", "cf.", "refer to", "shown in", "(")
//   - continuation of a cued list ("See Chapter 5, Figure 2.3, and Appendix A")
//   - an intrinsically referential form ("p. 462", "note on 3.6")
//   - a capitalized division label + numeral that names a node which exists
// Words without a numeral ("the first chapter of his life") never qualify.

import { parseNumber } from "./content";
import type { PageMapEntry } from "./layout";
import { markerClass } from "./markers";
import type { Signal } from "./reconcile";
import type { Block, RefCandidate, RefType, StructureNode, StructureType } from "./types";

export interface InternalRefDetection {
  blockId: string;
  start: number;
  end: number;
  type: RefType;
  key: string;
  to: string | null;
  toSection: string | null;
  method: "heuristic" | "page-map" | "line-key" | "unresolved";
  confidence: number;
  evidence: string[];
  candidates?: RefCandidate[];
  ambiguous?: boolean;
  note?: string;
  /** recognition evidence: why the expression functions as a reference */
  signals: Signal[];
}

const CUE =
  /(?:\b(?:see(?:\s+also)?|cf\.?|compare|refer(?:red)?\s+to|(?:as\s+)?(?:discussed|described|shown|given|listed|explained|noted|treated)\s+(?:in|at|on)|(?:set\s+out|reproduced|printed)\s+in)\s*|\(\s*)$/i;
const CONTINUATION = /(?:,\s*(?:and\s+|or\s+)?|\s+(?:and|or)\s+|;\s*)$/i;

const DIV_WORD: Record<string, StructureType | "figure" | "table" | "canto"> = {
  chapter: "chapter", chapters: "chapter", "chap.": "chapter", "ch.": "chapter",
  book: "book", books: "book",
  volume: "volume", volumes: "volume", "vol.": "volume",
  part: "part", parts: "part",
  section: "section", sections: "section", "sect.": "section", "sec.": "section", "§": "section",
  appendix: "appendix", appendices: "appendix",
  canto: "canto", cantos: "canto", act: "canto", acts: "canto",
  figure: "figure", figures: "figure", "fig.": "figure", "figs.": "figure",
  table: "table", tables: "table",
};

const DIVISION =
  /(?<![\w])(Chapters?|Chap\.|Ch\.|Books?|Volumes?|Vol\.|Parts?|Sections?|Sect\.|Sec\.|§|Appendix|Appendices|Cantos?|Acts?|Figures?|Figs?\.|Tables?)\s*(\d{1,3}(?:\.\d{1,4})*|[IVXLCDM]{1,7}|[A-Z])(?![\w])(?:\s*[–-]\s*(\d{1,4}))?(?:,?\s*(?:lines?|ll?\.)\s*(\d{1,4})(?:\s*[–-]\s*(\d{1,4}))?)?(?:\s*ff?\.)?/gi;
const PAGE = /(?<![\w])(pp?\.)\s?(\d{1,4})(?:\s*[–-]\s*(\d{1,4}))?(?:\s*ff?\.)?/gi;
const LOCUS = /(?<![\w.])(?:(\d{1,2})\.(\d{1,4})(?:\s*[–-]\s*\d{1,4})?(?:\s*ff?\.)?|(\d{1,4})\s*ff?\.)(?![\w])/g;
const NOTE_ON = /\bnotes?\s+(?:on|to|at)\s+((?:ll?\.\s*|lines?\s+)?[\w.]*\w)/gi;
const DIRECTION = /\bsee\s+(above|below|earlier|later)\b/gi;

export function detectInternalRefs(
  blocks: Block[],
  structure: StructureNode[],
  pageMap: PageMapEntry[],
): InternalRefDetection[] {
  const byId = new Map(structure.map((s) => [s.id, s]));
  const firstBlock = (s: StructureNode) => blocks[s.start]?.id ?? null;
  const ancestors = (sectionId: string) => {
    const out = new Set<string>();
    for (let c = byId.get(sectionId); c; c = c.parent ? byId.get(c.parent) : undefined) out.add(c.id);
    return out;
  };
  const captions = blocks.filter((b) => b.type === "caption" || b.type === "heading");
  const entries = blocks.filter((b) => b.type === "entry" && b.key);
  const verse = blocks.filter((b) => b.type === "verse-line" && b.line != null);

  const out: InternalRefDetection[] = [];

  for (const b of blocks) {
    if (b.type === "heading") continue;
    const text = b.text;
    const found: InternalRefDetection[] = [];
    const scope = ancestors(b.section);
    const cued = (at: number) => CUE.test(text.slice(Math.max(0, at - 32), at));
    /** the referring cue or list continuation in front of an expression */
    const cueSignals = (at: number): Signal[] =>
      cued(at) ? [{ kind: "cue" }] : continues(at) ? [{ kind: "cued-list" }] : [];
    const continues = (at: number) => {
      const before = text.slice(0, at);
      const m = CONTINUATION.exec(before);
      if (!m) return false;
      const joinAt = before.length - m[0].length;
      return found.some((f) => f.end === joinAt);
    };

    /** pick among plausible structure nodes; prefer ones sharing the source's scope */
    const choose = (pool: { id: string; block: string | null; why: string }[], key: string) => {
      if (pool.length <= 1) return { hit: pool[0] ?? null, candidates: undefined };
      const scoped = pool.filter((p) => {
        const node = byId.get(p.id);
        return node?.parent != null && scope.has(node.parent);
      });
      if (scoped.length === 1) return { hit: scoped[0]!, candidates: undefined };
      return {
        hit: null,
        candidates: pool.slice(0, 6).map((p) => ({ to: p.block ?? p.id, key, system: "structure", score: 50, why: p.why })),
      };
    };

    // -- divisions, figures, tables, appendices -------------------------------
    for (const m of text.matchAll(DIVISION)) {
      const at = m.index ?? 0;
      const raw = m[1]!;
      const kind = DIV_WORD[raw.toLowerCase()];
      const numeral = m[2]!;
      if (!kind) continue;
      // alphabetic numerals must be printed as capitals ("Book I", "Appendix A")
      if (/[a-z]/.test(numeral)) continue;
      const capital = /^[A-Z§]/.test(raw);
      const isCued = cued(at) || continues(at);
      if (!capital && !isCued) continue;
      const end = at + m[0].length;
      const key = m[0].trim();
      const evidence: string[] = [];
      if (cued(at)) evidence.push("preceded by an explicit referring cue");
      else if (continues(at)) evidence.push("continues a list of references");

      if (kind === "figure" || kind === "table") {
        const re = new RegExp(`^(?:${kind === "figure" ? "fig(?:ure)?\\.?" : "table"})\\s*${numeral.replace(/\./g, "\\.")}(?![\\w.]*\\d)`, "i");
        const pool = captions.filter((c) => re.test(c.text.trim()));
        if (!pool.length && !isCued) continue;
        const ambiguous = pool.length > 1;
        found.push({
          blockId: b.id, start: at, end, type: kind, key,
          to: ambiguous ? null : (pool[0]?.id ?? null), toSection: null,
          method: pool.length === 1 ? "heuristic" : "unresolved",
          confidence: pool.length === 1 ? 0.85 : ambiguous ? 0.4 : 0.3,
          evidence: [...evidence, pool.length ? `caption "${pool[0]!.text.slice(0, 40)}" labels this ${kind}` : `no ${kind} captioned ${numeral}`],
          signals: [...cueSignals(at), ...(capital ? [{ kind: "capitalized-label" as const }] : []), ...(pool.length ? [{ kind: "named-node-exists" as const }] : [])],
          ...(ambiguous ? { ambiguous: true, candidates: pool.slice(0, 6).map((c) => ({ to: c.id, key, system: "captions", score: 50, why: `caption on p${c.page}` })) } : {}),
        });
        continue;
      }

      const dotted = /^\d+\.\d+/.test(numeral) && kind !== "section";
      const head = dotted ? numeral.split(".")[0]! : numeral;
      const num = parseNumber(head);
      const wanted: StructureType = kind === "canto" ? "chapter" : kind;
      const pool = structure
        .filter(
          (s) =>
            s.type === wanted &&
            ((num != null && s.number === num) ||
              s.label.toUpperCase().endsWith(` ${numeral}`) ||
              s.title.toUpperCase() === numeral),
        )
        .map((s) => ({ id: s.id, block: firstBlock(s), why: `${s.type} "${s.label}" on p${s.page}` }));
      if (!pool.length && !isCued) continue;
      const { hit, candidates } = choose(pool, key);
      if (pool.length) evidence.push(`${wanted} ${numeral} exists in the document structure`);

      // a locus inside the division ("Book 1.136", "Book 2, line 40") narrows to a verse line
      const lineNo = dotted ? Number(numeral.split(".")[1]) : m[4] ? Number(m[4]) : null;
      let to = hit?.block ?? null;
      if (hit && lineNo != null) {
        const node = byId.get(hit.id)!;
        const line = blocks.slice(node.start, node.end).find((x) => x.type === "verse-line" && x.line === lineNo);
        if (line) {
          to = line.id;
          evidence.push(`line ${lineNo} of ${node.label}`);
        }
      }
      const type: RefType = lineNo != null ? "cross-reference" : wanted === "appendix" ? "appendix" : "structural-navigation";
      found.push({
        blockId: b.id, start: at, end, type, key,
        to, toSection: hit?.id ?? null,
        method: hit ? (lineNo != null ? "line-key" : "heuristic") : "unresolved",
        confidence: hit ? (isCued ? 0.9 : 0.75) : candidates ? 0.4 : 0.3,
        evidence,
        signals: [...cueSignals(at), ...(capital ? [{ kind: "capitalized-label" as const }] : []), ...(pool.length ? [{ kind: "named-node-exists" as const }] : [])],
        ...(candidates ? { ambiguous: true, candidates } : {}),
        ...(!pool.length ? { note: `no ${wanted} ${numeral} in this document's structure` } : {}),
      });
    }

    // -- printed page references ----------------------------------------------
    for (const m of text.matchAll(PAGE)) {
      const at = m.index ?? 0;
      const printed = Number(m[2]);
      const arabic = pageMap.filter((e) => !e.roman && e.printed === printed);
      const entry = arabic.length === 1 ? arabic[0] : arabic.length === 0 ? pageMap.find((e) => e.printed === printed) : undefined;
      const target = entry ? blocks.find((x) => x.prov?.page === entry.pdfPage || x.page === entry.pdfPage) : undefined;
      const ambiguous = arabic.length > 1;
      found.push({
        blockId: b.id, start: at, end: at + m[0].length, type: "page-reference", key: m[0],
        to: target?.id ?? null, toSection: null,
        method: entry ? "page-map" : "unresolved",
        signals: [...cueSignals(at), { kind: "intrinsic-form", note: "page abbreviation with a number" }],
        confidence: entry ? (target ? 0.85 : 0.5) : 0.3,
        evidence: entry
          ? [`printed page ${printed} is PDF page ${entry.pdfPage} in this edition's page map`]
          : ambiguous
            ? [`printed page ${printed} occurs ${arabic.length} times in the page map`]
            : ["the edition's pagination could not be recovered, so printed page numbers cannot be mapped"],
        ...(ambiguous
          ? { ambiguous: true, candidates: arabic.map((e) => ({ to: blocks.find((x) => x.page === e.pdfPage)?.id ?? "", key: m[0], system: "page-map", score: 50, why: `PDF page ${e.pdfPage}` })).filter((c) => c.to) }
          : {}),
        ...(entry || ambiguous ? {} : { note: "printed page number — no page map could be recovered" }),
      });
    }

    // -- "note on 3.6" ---------------------------------------------------------
    for (const m of text.matchAll(NOTE_ON)) {
      const at = m.index ?? 0;
      const key = m[1]!.replace(/^(?:ll?\.\s*|lines?\s+)/i, "").replace(/\.$/, "");
      const end = at + m[0].length - (m[1]!.length - m[1]!.replace(/\.$/, "").length);
      const keyLike = /\d/.test(key) || markerClass(key) != null;
      const pool = keyLike ? entries.filter((e) => e.key === key) : [];
      found.push({
        blockId: b.id, start: at, end, type: "note", key,
        to: pool.length === 1 ? pool[0]!.id : null, toSection: null,
        method: pool.length === 1 ? "heuristic" : "unresolved",
        confidence: pool.length === 1 ? 0.85 : 0.3,
        // "note on 3.6" is a reference form; "the note on this argument" is prose
        signals: [
          ...cueSignals(at),
          keyLike
            ? { kind: "intrinsic-form" as const, note: `names note key ${key}` }
            : { kind: "vocabulary-only" as const, note: `"${key}" is not a note key` },
        ],
        evidence: ["the text names a note by its key", pool.length ? `${pool.length} note entr${pool.length > 1 ? "ies" : "y"} keyed ${key}` : `no note keyed ${key}`],
        ...(pool.length > 1 ? { ambiguous: true, candidates: pool.slice(0, 6).map((e) => ({ to: e.id, key, system: e.system ?? "notes", score: 50, why: `entry on p${e.page}` })) } : {}),
      });
    }

    // -- bare loci "1.136–40", "508ff." — only with a cue or inside a cued list --
    for (const m of text.matchAll(LOCUS)) {
      const at = m.index ?? 0;
      if (!(cued(at) || continues(at))) continue;
      let pool: Block[];
      if (m[1]) {
        const div = Number(m[1]);
        const line = Number(m[2]);
        const nodes = structure.filter((s) => (s.type === "book" || s.type === "chapter") && s.number === div);
        pool = nodes.flatMap((n) => blocks.slice(n.start, n.end).filter((x) => x.type === "verse-line" && x.line === line));
      } else {
        const line = Number(m[3]);
        pool = verse.filter((x) => x.line === line);
        const scoped = pool.filter((x) => [...ancestors(x.section)].some((id) => scope.has(id) && byId.get(id)?.type !== "root"));
        if (pool.length > 1 && scoped.length === 1) pool = scoped;
      }
      if (!pool.length && !cued(at)) continue;
      found.push({
        blockId: b.id, start: at, end: at + m[0].length, type: "cross-reference", key: m[0],
        to: pool.length === 1 ? pool[0]!.id : null, toSection: null,
        method: pool.length === 1 ? "line-key" : "unresolved",
        confidence: pool.length === 1 ? 0.8 : 0.3,
        signals: cueSignals(at),
        evidence: ["line locus preceded by a referring cue", pool.length ? `${pool.length} verse line(s) numbered accordingly` : "no verse line carries this number"],
        ...(pool.length > 1 ? { ambiguous: true, candidates: pool.slice(0, 6).map((x) => ({ to: x.id, key: m[0], system: "line-numbering", score: 50, why: `verse line on p${x.page}` })) } : {}),
      });
    }

    // -- "see above" / "see below": intentional, but names no location ---------
    for (const m of text.matchAll(DIRECTION)) {
      const at = m.index ?? 0;
      found.push({
        blockId: b.id, start: at, end: at + m[0].length, type: "cross-reference", key: m[0],
        to: null, toSection: null, method: "unresolved", confidence: 0.3,
        signals: [{ kind: "cue" }],
        evidence: ["explicit directional cross-reference"],
        note: "points in a direction, not to a named location",
      });
    }

    // overlapping expressions: keep the earliest, longest, one per range
    found.sort((a, c) => a.start - c.start || c.end - a.end);
    for (const f of found) {
      if (out.some((o) => o.blockId === b.id && f.start < o.end && o.start < f.end)) continue;
      out.push(f);
    }
  }
  return out;
}
