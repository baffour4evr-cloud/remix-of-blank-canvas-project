import type { ApparatusEntry } from "./apparatus";
import type { PageMapEntry } from "./layout";
import { isProse, type Block, type RawLink, type RefCandidate, type RefEdge, type RefSystem, type RefType, type StructureNode } from "./types";
import { disjoinRanges, isMarkerLike, literalSpan, markerSpan, openingSpan, phraseSpan, snapToWords } from "./anchor";
import { GLUED_SYMBOL, markerClass, markerKey } from "./markers";
import { detectInternalRefs } from "./internal-refs";
import { sentenceAt } from "./sentences";
import { discoverReferenceSystems, type DocumentMarkerCensus } from "./discover";
import { reconcile, type Proposed, type RecognitionRecord, type Signal } from "./reconcile";


/**
 * Semantic classification of an edge from the system that owns it. A document
 * runs several systems at once, so the type is decided per system, never once
 * for the whole document.
 */
function refTypeForSystem(sys: RefSystem | undefined): RefType {
  if (!sys) return "note";
  const l = sys.label.toLowerCase();
  if (/translat/.test(l)) return "translator-note";
  if (/author/.test(l)) return "author-note";
  if (/editor/.test(l)) return "editorial-note";
  switch (sys.kind) {
    case "line-commentary":
      return "line-note";
    case "footnote":
      return "footnote";
    case "endnote":
      return "endnote";
    case "textual-apparatus":
      return "textual-note";
    case "bibliography":
      return "bibliography";
    case "glossary":
      return "glossary";
    case "appendix":
      return "appendix";
    case "translator-note":
      return "translator-note";
    case "editorial-note":
      return "editorial-note";
    default:
      return "note";
  }
}



interface Scope {
  volume: number | null;
  book: number | null;
  part: number | null;
  chapter: number | null;
  inApparatus: boolean;
}

// tolerate the stray space extraction sometimes leaves inside the brackets
const INLINE_MARKER = /\[\s?(\d{1,3}|\*{1,3}|†{1,3}|‡{1,3})\s?\]/g;
const PAREN_MARKER = /(?<=[\p{L}.,;:!?'"’”])\s?(\((\d{1,3})\))(?![\p{L}\p{N}])/gu;
/** a raised or bracketed numeral inside a formula is an exponent or index, not a note */
const MATH_AFTER = /^\s*[=+×÷^<>]|^\s*[-−]\s*\d/;
const MARKER_GRAMMARS = new Set<RefSystem["grammar"]>(["sequential", "bracketed", "symbol", "alphabetic", "roman"]);
const AUTHOR_DATE_CITE = /\(([A-Z][\w'’-]+)[^)]{0,40}?\b(1[6-9]\d{2}|20\d{2})[a-z]?\)/g;

const OPENERS = "[({<";
const CLOSERS = "])}>";

/**
 * Widen a marker range onto the brackets or parentheses that enclose it, so
 * "[6]" is the reference marker rather than the bare "6" inside it.
 */
function bracketed(text: string, at: number, len: number): { at: number; len: number } {
  const open = OPENERS.indexOf(text[at - 1] ?? "");
  if (open >= 0 && text[at + len] === CLOSERS[open]) return { at: at - 1, len: len + 2 };
  return { at, len };
}

/** A link annotation together with the page it was printed on. */
export interface PageLink extends RawLink {
  page: number;
}

export interface RefContext {
  links?: PageLink[];
  pageMap?: PageMapEntry[];
}

export function buildReferences(
  blocks: Block[],
  structure: StructureNode[],
  systems: RefSystem[],
  entries: ApparatusEntry[],
  ctx: RefContext = {},
): {
  refs: RefEdge[];
  unresolved: { label: string; from: string; reason: string }[];
  recognition: RecognitionRecord[];
  census: DocumentMarkerCensus;
} {
  const pageMap: PageMapEntry[] = ctx.pageMap ?? [];

  const byId = new Map(structure.map((s) => [s.id, s]));
  const scopeCache = new Map<string, Scope>();
  const scopeOf = (sectionId: string): Scope => {
    const hit = scopeCache.get(sectionId);
    if (hit) return hit;
    const scope: Scope = { volume: null, book: null, part: null, chapter: null, inApparatus: false };
    let cur = byId.get(sectionId);
    while (cur) {
      if (cur.type === "apparatus" || cur.type === "appendix") scope.inApparatus = true;
      if (cur.number != null) {
        if (cur.type === "volume" && scope.volume == null) scope.volume = cur.number;
        if (cur.type === "book" && scope.book == null) scope.book = cur.number;
        if (cur.type === "part" && scope.part == null) scope.part = cur.number;
        if (cur.type === "chapter" && scope.chapter == null) scope.chapter = cur.number;
      }
      cur = cur.parent ? byId.get(cur.parent) : undefined;
    }
    scopeCache.set(sectionId, scope);
    return scope;
  };

  const blockById = new Map(blocks.map((b) => [b.id, b]));
  const systemById = new Map(systems.map((s) => [s.id, s]));
  const entriesBySystem = new Map<string, ApparatusEntry[]>();
  for (const e of entries) {
    const arr = entriesBySystem.get(e.system) ?? [];
    arr.push(e);
    entriesBySystem.set(e.system, arr);
  }

  const refs: Proposed[] = [];
  const unresolved: { label: string; from: string; reason: string }[] = [];
  /** edges whose range is a verbatim printed marker: never re-snapped or trimmed */
  const exactIds = new Set<string>();
  let rid = 0;

  /**
   * Emit an edge with its full semantic anchoring. The popup layer must never
   * have to re-derive context from PDF lines, so every edge carries the exact
   * marker span plus the *complete* sentence and paragraph containing it,
   * measured on normalized text and never truncated.
   */
  const push = (
    r: Omit<
      RefEdge,
      | "id"
      | "marker"
      | "sentence"
      | "paragraph"
      | "destinationNodeId"
      | "key"
      | "evidence"
      | "sourceText"
      | "targetLocation"
      | "provenance"
    > & {
      key?: string;
      length?: number;
      evidence?: string[];
      candidates?: RefCandidate[];
      targetLocation?: { start: number; end: number } | null;
      provenance?: RefEdge["provenance"];
      /** the range is a verbatim printed marker and must be preserved exactly */
      exact?: boolean;
      /** why the text is believed to function as a reference (recognition evidence) */
      signals: Signal[];
    },
  ) => {
    const host = blockById.get(r.from);
    const text = host?.text ?? "";
    const start = Math.max(0, Math.min(r.at, text.length));
    const end = Math.min(text.length, start + (r.length ?? r.label.length));
    const s = sentenceAt(text, start);
    const { length: _len, evidence, key, targetLocation, provenance, exact, signals, ...rest } = r;
    if (exact) exactIds.add(`r${rid}`);
    refs.push({
      signals,
      exact: !!exact,
      ...rest,
      id: `r${rid++}`,
      key: key ?? r.label,
      marker: { blockId: r.from, start, end },
      sentence: { blockId: r.from, start: s.start, end: s.end },
      paragraph: { blockId: r.from, start: 0, end: text.length },
      destinationNodeId: r.to,
      evidence: evidence ?? [],
      sourceText: text.slice(start, end),
      targetLocation: targetLocation ?? null,
      provenance: provenance ?? "inferred",
    });
  };

  const bodyBlocks = blocks.filter((b) => !scopeOf(b.section).inApparatus);
  // Discover the document's reference systems and marker habits before any
  // marker is matched; recognition below consults this census.
  const census = discoverReferenceSystems(bodyBlocks, blocks, systems, entries);

  // -- 0. explicit link annotations ------------------------------------------
  // An internal link in the file is the strongest evidence a document can give
  // that two places are related, and it exists whether or not the parser has
  // yet discovered and named a reference *system*. Harvest every one of them
  // first, anchor it on the exact text the annotation covers, and classify it
  // afterwards from whatever it happens to point at.
  const linksByPage = new Map<number, PageLink[]>();
  for (const l of ctx.links ?? []) {
    const arr = linksByPage.get(l.page) ?? [];
    arr.push(l);
    linksByPage.set(l.page, arr);
  }
  if (linksByPage.size) {
    /** blocks that carry a source box on a given page */
    const boxesByPage = new Map<number, { b: Block; y: number; x: number; w: number; h: number }[]>();
    for (const b of blocks) {
      for (const box of b.prov?.boxes ?? []) {
        const arr = boxesByPage.get(box.page) ?? [];
        arr.push({ b, y: box.y, x: box.x, w: box.w, h: box.h });
        boxesByPage.set(box.page, arr);
      }
    }
    /**
     * The node a link destination lands on. A destination names the *top* of
     * what it points to, so the target is the node whose box contains that
     * point, else the first node set below it — never the nearest box edge,
     * which picks the heading printed just above the note. When the anchor is
     * a printed marker, a nearby entry carrying that same key is preferred:
     * marker identity is stronger evidence than a coordinate.
     */
    const targetFor = (page: number, y: number | null | undefined, anchor: string): Block | null => {
      const cands = boxesByPage.get(page);
      if (!cands?.length) return null;
      const topDown = [...cands].sort((a, b) => b.y + b.h - (a.y + a.h));
      let i = 0;
      if (y != null) {
        const inside = topDown.findIndex((c) => y >= c.y - 2 && y <= c.y + c.h + 2);
        const below = topDown.findIndex((c) => c.y + c.h <= y + 2);
        if (inside < 0 && below < 0) {
          // the point lies under everything printed on the page: the content it
          // names begins at the top of the following page
          const next = (boxesByPage.get(page + 1) ?? []).sort((a, b) => b.y + b.h - (a.y + a.h));
          if (next.length) {
            const key = anchor && isMarkerLike(anchor) ? markerKey(anchor) : "";
            const keyed = key ? next.slice(0, 3).find((c) => c.b.type === "entry" && markerKey(c.b.key ?? "") === key) : null;
            return (keyed ?? next[0]!).b;
          }
        }
        i = inside >= 0 ? inside : below >= 0 ? below : topDown.length - 1;
      }
      const hit = topDown[i]!.b;
      const key = anchor && isMarkerLike(anchor) ? markerKey(anchor) : "";
      if (key && !(hit.type === "entry" && markerKey(hit.key ?? "") === key)) {
        const near = topDown.slice(i, i + 3).find((c) => c.b.type === "entry" && markerKey(c.b.key ?? "") === key);
        if (near) return near.b;
      }
      return hit;
    };
    const sectionOfPage = (page: number): StructureNode | null => {
      let hit: StructureNode | null = null;
      for (const s of structure) if (s.page <= page && (!hit || s.page >= hit.page) && s.type !== "root") hit = s;
      return hit;
    };

    for (const [page, links] of linksByPage) {
      const cands = boxesByPage.get(page) ?? [];
      for (const link of links) {
        const hits = cands.filter(
          (c) => c.y >= link.y - 3 && c.y <= link.y + link.h + 3 && c.x < link.x + link.w + 2 && c.x + c.w > link.x - 2,
        );
        const source = hits[0]?.b;
        if (!source) continue;
        const anchor = (link.text ?? "").trim();
        // The annotation already states which characters are linked, so that
        // range *is* the reference. A printed marker ("6", "[6]", "*") takes its
        // enclosing brackets when the page prints them; anything else is matched
        // verbatim. Either way the range is never widened onto a neighbouring
        // word, sentence or paragraph, and never shortened.
        const markerish = anchor ? isMarkerLike(anchor) : false;
        const marker = markerish ? markerSpan(source.text, anchor) : null;
        const literal = anchor ? literalSpan(source.text, anchor) : null;
        let span = marker ?? literal ?? (anchor ? phraseSpan(source.text, anchor) : null);
        if (!span && !anchor) span = openingSpan(source.text, 6);
        if (!span) continue;
        const exact = !!marker || !!literal;
        const snapped = exact
          ? { start: span.start, end: span.end }
          : snapToWords(source.text, span.start, span.end, false);
        if (!snapped) continue;


        const to = link.url ? null : link.destPage != null ? targetFor(link.destPage, link.destY, (link.text ?? "").trim()) : null;
        const toSection = to ? null : link.destPage != null ? (sectionOfPage(link.destPage)?.id ?? null) : null;
        const targetSystem = to?.system ?? null;
        const type: RefType = link.url
          ? "external"
          : to && to.type === "entry"
            ? refTypeForSystem(systemById.get(targetSystem ?? ""))
            : to || toSection
              ? "structural-navigation"
              : "hyperlink";
        push({
          type,
          system: targetSystem,
          from: source.id,
          at: snapped.start,
          length: snapped.end - snapped.start,
          exact,
          key: anchor || source.text.slice(snapped.start, snapped.end),
          label: anchor || source.text.slice(snapped.start, snapped.end),
          to: to?.id ?? null,
          toSection,
          method: "link",
          confidence: to || link.url ? 0.99 : 0.7,
          provenance: "explicit-link",
          signals: [{ kind: "explicit-link", note: `annotation on page ${page}` }],
          link: {
            ...(link.id ? { id: link.id } : {}),
            page,
            rect: { x: link.x, y: link.y, w: link.w, h: link.h },
            sourceCharRange: link.charRange ?? null,
            sourceRange: { start: snapped.start, end: snapped.end },
            destPage: link.destPage ?? null,
            destY: link.destY ?? null,
            url: link.url ?? null,
          },
          evidence: [
            `link annotation on page ${page} covering “${anchor || "(no text)"}”`,
            link.url
              ? `external destination ${link.url}`
              : link.destPage != null
                ? `internal destination on page ${link.destPage}${link.destY != null ? ` at y≈${Math.round(link.destY)}` : ""}`
                : "destination could not be resolved from the file",
            to ? `nearest normalized node at that destination is ${to.type} ${to.id}` : "no node found at the destination",
          ],
        });
        if (!to && !toSection && !link.url) {
          unresolved.push({ label: anchor || "link", from: source.id, reason: "link annotation has no resolvable destination" });
        }
      }
    }
  }



  // -- 1. inline note markers -------------------------------------------------
  // Markers are not assumed to be numbers. A printed token is a *candidate*
  // marker when the typography sets it apart (superscript, or brackets around a
  // number); a symbol glued to a word ("word†") is a candidate only when a note
  // system with that key exists. Every candidate is resolved by identity first,
  // then by the system's own evidence: page proximity for footnotes, structural
  // scope, and document order inside the system.
  const markerSystems = systems.filter((s) => MARKER_GRAMMARS.has(s.grammar));
  const markerSystemIds = new Set(markerSystems.map((s) => s.id));
  const systemKeys = new Set(
    entries.filter((e) => markerSystemIds.has(e.system)).map((e) => markerKey(e.key)),
  );
  const entryIndex = new Map<string, ApparatusEntry[]>();
  for (const e of entries) {
    if (!markerSystemIds.has(e.system)) continue;
    const k = markerKey(e.key);
    entryIndex.set(k, [...(entryIndex.get(k) ?? []), e]);
  }
  const entryOrder = new Map(blocks.map((b, i) => [b.id, i]));
  /** per system: document position of the last entry a marker consumed */
  const cursor = new Map<string, number>();
  const linkedRanges = new Map<string, { start: number; end: number }[]>();
  for (const r of refs) {
    if (r.provenance !== "explicit-link") continue;
    linkedRanges.set(r.from, [...(linkedRanges.get(r.from) ?? []), { start: r.marker.start, end: r.marker.end }]);
  }

  for (const b of bodyBlocks) {
    if (b.type === "heading" || b.type === "entry") continue;
    const found: { key: string; at: number; len: number; why: string; typographic: boolean; signals: Signal[] }[] = [];
    const mathAfter = (at: number, len: number) => MATH_AFTER.test(b.text.slice(at + len, at + len + 4));
    const taken = (at: number, len: number) => found.some((f) => at < f.at + f.len && f.at < at + len);
    let offset = 0;
    for (const r of b.runs) {
      if (r.sup) {
        const key = markerKey(r.t);
        // the marker is the printed token: keep the brackets that enclose it,
        // even when they live in the neighbouring run, and drop the run's own
        // leading/trailing whitespace
        const lead = r.t.length - r.t.trimStart().length;
        const span = bracketed(b.text, offset + lead, r.t.trim().length);
        const cls = markerClass(key);
        // a raised letter is often an ordinal or abbreviation ("2e", "Mme"):
        // letters and numerals count only when a system prints that key
        const lettered = cls === "alphabetic" || cls === "roman";
        if (cls && !taken(span.at, span.len) && (!lettered || systemKeys.has(key))) {
          const sig: Signal[] = [{ kind: "superscript" }];
          if (mathAfter(span.at, span.len)) sig.push({ kind: "math-context", note: "followed by an operator" });
          if (cls === "numeric" && (census.usage.superscript.numeric ?? 0) < 2) {
            sig.push({ kind: "isolated-typography", note: "the only raised numeral in the document" });
          }
          found.push({ key, ...span, why: `superscript marker "${key}"`, typographic: !lettered, signals: sig });
        }
      }
      offset += r.t.length;
    }
    for (const m of b.text.matchAll(INLINE_MARKER)) {
      const at = m.index ?? 0;
      if (!taken(at, m[0]!.length)) {
        const sig: Signal[] = [{ kind: "bracketed" }];
        if (mathAfter(at, m[0]!.length)) sig.push({ kind: "math-context", note: "followed by an operator" });
        found.push({ key: markerKey(m[0]!), at, len: m[0]!.length, why: `bracketed marker "${m[0]}"`, typographic: true, signals: sig });
      }
    }
    // "(12)" counts only when the document demonstrably numbers its markers
    // that way and a system prints the key — otherwise it is a list item or aside
    if (census.confirmedSettings.includes("parenthesized")) {
      for (const m of b.text.matchAll(PAREN_MARKER)) {
        const at = (m.index ?? 0) + m[0]!.indexOf("(");
        if (!systemKeys.has(m[2]!) || taken(at, m[1]!.length)) continue;
        found.push({
          key: m[2]!,
          at,
          len: m[1]!.length,
          why: `parenthesized marker "${m[1]}"`,
          typographic: false,
          signals: [{ kind: "parenthesized", note: "the document numbers markers in parentheses" }],
        });
      }
    }
    for (const m of b.text.matchAll(GLUED_SYMBOL)) {
      const at = m.index ?? 0;
      // a bare symbol proves nothing: it needs a system that prints that key
      if (!systemKeys.has(m[1]!) || taken(at, m[1]!.length)) continue;
      found.push({ key: m[1]!, at, len: m[1]!.length, why: `symbol "${m[1]}" set against the preceding word`, typographic: false, signals: [{ kind: "glued-symbol" }] });
    }
    found.sort((x, y) => x.at - y.at);

    for (const f of found) {
      // an explicit link on the same characters is stronger evidence than any inference
      if ((linkedRanges.get(b.id) ?? []).some((l) => f.at < l.end && l.start < f.at + f.len)) continue;
      const scope = scopeOf(b.section);
      const here = entryOrder.get(b.id) ?? 0;
      const candidates: RefCandidate[] = [];
      let best: ApparatusEntry | null = null;
      let bestScore = -Infinity;
      for (const e of entryIndex.get(f.key) ?? []) {
        const sys = systemById.get(e.system);
        const es = scopeOf(e.section);
        const at = entryOrder.get(e.blockId) ?? 0;
        const target = blockById.get(e.blockId);
        let score = 1;
        const why: string[] = [`key "${f.key}" in ${sys?.label ?? e.system}`];
        if (sys?.kind === "footnote") {
          // a footnote sits on the marker's own page, or the next one
          const d = (target?.page ?? 0) - b.page;
          const s = d === 0 ? 4 : d === 1 ? 2 : -6;
          score += s;
          why.push(d === 0 ? "same page" : d === 1 ? "next page" : `${d} pages away`);
          if (at < here) score -= 4;
        }
        if (scope.chapter != null && es.chapter != null) {
          score += scope.chapter === es.chapter ? 3 : -5;
          why.push(scope.chapter === es.chapter ? "same chapter" : "other chapter");
        }
        if (scope.volume != null && es.volume != null) score += scope.volume === es.volume ? 2 : -4;
        if (scope.book != null && es.book != null) score += scope.book === es.book ? 2 : -4;
        // notes are consumed in document order: the next unused entry with this
        // key after the system's last match is the expected one
        const c = cursor.get(e.system) ?? -1;
        if (at > c) {
          const nextSame = (entryIndex.get(f.key) ?? []).filter(
            (x) => x.system === e.system && (entryOrder.get(x.blockId) ?? 0) > c,
          );
          const first = nextSame.reduce((m, x) => Math.min(m, entryOrder.get(x.blockId) ?? 0), Infinity);
          if (first === at) {
            score += 2;
            why.push("next in sequence");
          }
        }
        candidates.push({ to: e.blockId, key: e.key, system: e.system, score, why: why.join(", ") });
        if (score > bestScore) {
          bestScore = score;
          best = e;
        }
      }
      const rivals = candidates.filter((c) => c.score === bestScore);
      if (best && bestScore > 0) {
        cursor.set(best.system, Math.max(cursor.get(best.system) ?? -1, entryOrder.get(best.blockId) ?? 0));
        const sys = systemById.get(best.system);
        push({
          type: refTypeForSystem(sys),
          system: best.system,
          from: b.id,
          at: f.at,
          length: f.len,
          exact: true,
          key: f.key,
          label: f.key,
          to: best.blockId,
          toSection: null,
          method: "marker",
          confidence: rivals.length > 1 ? 0.5 : bestScore >= 4 ? 0.97 : 0.75,
          signals: [
            ...f.signals,
            { kind: "system-key", note: `${sys?.label ?? best.system} prints "${f.key}"` },
            ...(candidates.find((c) => c.to === best!.blockId)?.why.includes("next in sequence") ? [{ kind: "sequence" as const }] : []),
          ],
          evidence: [
            f.why,
            `matched entry "${best.key}" in ${sys?.label ?? best.system} (${sys?.grammar ?? "?"} system)`,
            rivals.length > 1 ? `${rivals.length} entries share this key at the same score` : "unique best match",
          ],
          ...(rivals.length > 1 ? { candidates: rivals, ambiguous: true } : {}),
        });
      } else if (f.typographic) {
        // typography marks it as a marker, but no system confirms it: keep the
        // candidate visible as unresolved rather than invent a destination
        unresolved.push({ label: `note ${f.key}`, from: b.id, reason: "no note with that marker in scope" });
        push({
          type: "note",
          system: null,
          from: b.id,
          at: f.at,
          length: f.len,
          exact: true,
          key: f.key,
          label: f.key,
          to: null,
          toSection: null,
          method: "unresolved",
          confidence: 0.2,
          signals: f.signals,
          ...(candidates.length ? { candidates } : {}),
          evidence: [f.why, "no note entry carries this marker in an enclosing scope"],
        });
      }
    }
  }

  // -- 2. line-keyed commentary ----------------------------------------------
  // The text carries no marker at all: the note is keyed to a verse line, and
  // its lemma quotes that line. Anchor by number, confirm by lemma.
  const verseByBook = new Map<number, Block[]>();
  for (const b of blocks) {
    if (b.type !== "verse-line") continue;
    const s = scopeOf(b.section);
    if (s.inApparatus) continue;
    const key = s.book ?? s.chapter ?? 0;
    const arr = verseByBook.get(key) ?? [];
    arr.push(b);
    verseByBook.set(key, arr);
  }
  for (const sys of systems) {
    if (sys.grammar !== "line-keyed") continue;
    for (const e of entriesBySystem.get(sys.id) ?? []) {
      if (e.numeric == null) continue;
      const es = scopeOf(e.section);
      const bookNo = es.book ?? es.chapter;
      const pool = bookNo != null ? verseByBook.get(bookNo) : undefined;
      if (!pool || !pool.length) {
        unresolved.push({
          label: `${sys.label} ${e.key}`,
          from: e.blockId,
          reason: bookNo == null ? "entry group has no division heading" : `no verse found for division ${bookNo}`,
        });
        continue;
      }
      let target = pool.find((b) => b.line === e.numeric);
      let method: RefEdge["method"] = "line-key";
      let confidence = 0.85;
      if (!target) {
        target = [...pool].sort(
          (a, b) => Math.abs((a.line ?? 0) - e.numeric!) - Math.abs((b.line ?? 0) - e.numeric!),
        )[0];
        confidence = 0.6;
        method = "heuristic";
      }
      const evidence: string[] = [
        `commentary entry keyed "${e.key}" under ${sys.label}`,
        bookNo != null ? `entry group sits in division ${bookNo}` : "entry group division inferred",
        method === "line-key" ? `verse line ${e.numeric} found in that division` : `nearest verse line to ${e.numeric}`,
      ];
      if (e.lemma && target) {
        const needle = e.lemma.toLowerCase().replace(/[^a-z ]/g, "").trim().slice(0, 24);
        const window = pool.filter((b) => Math.abs((b.line ?? 0) - e.numeric!) <= 4);
        const hit = window.find((b) => needle && b.text.toLowerCase().replace(/[^a-z ]/g, "").includes(needle));
        if (hit) {
          target = hit;
          method = "lemma-match";
          confidence = 0.97;
          evidence.push(`lemma “${e.lemma}” occurs verbatim in line ${hit.line}`);
        } else {
          evidence.push(`lemma “${e.lemma}” not found within ±4 lines`);
        }
      }
      if (!target) continue;
      // The note points at the expression the entry quotes, not at the whole
      // metrical line: locate the complete lemma phrase inside the line so the
      // range covers exactly what the commentary discusses.
      let span = e.lemma ? phraseSpan(target.text, e.lemma) : null;
      if (span) {
        evidence.push(
          span.coverage === 1
            ? `lemma phrase anchored on characters ${span.start}–${span.end} of the line`
            : `${Math.round(span.coverage * 100)}% of the lemma phrase matched in the line`,
        );
        if (span.coverage < 1) confidence = Math.min(confidence, 0.8);
      } else {
        span = openingSpan(target.text);
        if (span) {
          const snapped = snapToWords(target.text, span.start, span.end);
          span = snapped ? { ...span, start: snapped.start, end: snapped.end } : null;
        }
        evidence.push("entry prints no quotable lemma — anchored on the line's opening phrase");
        confidence = Math.min(confidence, 0.65);
      }
      if (!span) continue;
      push({
        type: refTypeForSystem(sys),
        system: sys.id,
        from: target.id,
        at: span.start,
        length: span.end - span.start,
        key: e.key,
        label: e.lemma ? `${e.key} ${e.lemma}` : e.key,
        to: e.blockId,
        toSection: null,
        method,
        confidence,
        evidence,
        signals: [{ kind: "line-key" }, ...(method === "lemma-match" || evidence.some((x) => x.includes("verbatim")) ? [{ kind: "lemma" as const }] : [])],
      });
    }
  }

  // -- 2b. lemma / catchphrase note systems ----------------------------------
  // The entry carries no printed marker at all: it identifies its source by
  // quoting it. Resolve by locating that exact expression in the reading text,
  // preferring the occurrence nearest in document order to the entries already
  // placed, and reporting ambiguity instead of guessing when several occur.
  const lemmaSystems = systems.filter((s) => s.grammar === "lemma-keyed");
  if (lemmaSystems.length) {
    const orderOf = new Map(blocks.map((b, i) => [b.id, i]));
    const readable = bodyBlocks.filter((b) => isProse(b.type) || b.type === "verse-line");
    for (const sys of lemmaSystems) {
      let cursor = 0;
      for (const e of entriesBySystem.get(sys.id) ?? []) {
        if (!e.lemma) continue;
        const occurrences: { b: Block; span: { start: number; end: number; coverage: number } }[] = [];
        for (const b of readable) {
          const span = phraseSpan(b.text, e.lemma);
          if (span && span.coverage >= 0.85) occurrences.push({ b, span });
        }
        if (!occurrences.length) {
          unresolved.push({
            label: `${sys.label}: ${e.lemma}`,
            from: e.blockId,
            reason: "the quoted catchphrase does not occur in the reading text",
          });
          continue;
        }
        // notes run in document order, so the first occurrence at or after the
        // previous entry's match is the intended one
        const forward = occurrences.filter((o) => (orderOf.get(o.b.id) ?? 0) >= cursor);
        const chosen = forward[0] ?? occurrences[0]!;
        cursor = orderOf.get(chosen.b.id) ?? cursor;
        const ambiguous = forward.length > 1 && occurrences.length > 1;
        const snapped = snapToWords(chosen.b.text, chosen.span.start, chosen.span.end, false);
        if (!snapped) continue;
        push({
          type: refTypeForSystem(sys),
          system: sys.id,
          from: chosen.b.id,
          at: snapped.start,
          length: snapped.end - snapped.start,
          key: e.key,
          label: e.lemma,
          to: e.blockId,
          toSection: null,
          method: "lemma-match",
          confidence: ambiguous ? 0.55 : occurrences.length === 1 ? 0.93 : 0.8,
          signals: [{ kind: "lemma", note: `entry quotes “${e.lemma}”` }],
          evidence: [
            `entry in "${sys.label}" prints no marker and is keyed by the phrase it quotes`,
            `“${e.lemma}” occurs ${occurrences.length}× in the reading text`,
            ambiguous
              ? "several occurrences remain plausible — reported as ambiguous rather than guessed"
              : "the occurrence in document order after the previous entry was taken",
            `generated identifier ${e.key} (not printed in the source)`,
          ],
          ...(ambiguous
            ? {
                ambiguous: true,
                candidates: occurrences.slice(0, 6).map((o) => ({
                  to: o.b.id,
                  key: e.key,
                  system: sys.id,
                  score: Math.round(o.span.coverage * 100),
                  why: `lemma occurs in ${o.b.type} ${o.b.id}`,
                })),
              }
            : {}),
        });
      }
    }
  }

  // -- 3. semantic internal references without a hyperlink -------------------
  // Only expressions with evidence of intent become references; see
  // internal-refs.ts. Ranges are the referring expression itself, preserved exactly.
  for (const d of detectInternalRefs(blocks, structure, pageMap)) {
    push({
      type: d.type,
      system: null,
      from: d.blockId,
      at: d.start,
      length: d.end - d.start,
      label: d.key,
      key: d.key,
      to: d.to,
      toSection: d.toSection,
      method: d.method,
      confidence: d.confidence,
      evidence: d.evidence,
      exact: true,
      signals: d.signals,
      ...(d.candidates ? { candidates: d.candidates } : {}),
      ...(d.ambiguous ? { ambiguous: true } : {}),
      ...(d.note ? { note: d.note } : {}),
    });

  }

  // -- 4. author-date citations to the bibliography ---------------------------
  const bibSystems = systems.filter((s) => s.grammar === "author-date");
  if (bibSystems.length) {
    for (const b of blocks) {
      if (b.type === "heading" || b.type === "entry") continue;
      for (const m of b.text.matchAll(AUTHOR_DATE_CITE)) {
        const surname = m[1]!.toLowerCase();
        const year = m[2]!;
        let to: string | null = null;
        let sysId: string | null = null;
        for (const s of bibSystems) {
          const e = (entriesBySystem.get(s.id) ?? []).find(
            (x) =>
              typeof x.key === "string" &&
              x.key.toLowerCase().startsWith(surname) &&
              x.key.endsWith(year),
          );
          if (e) {
            to = e.blockId;
            sysId = s.id;
            break;
          }
        }
        push({
          type: "bibliography",
          system: sysId,
          from: b.id,
          at: m.index ?? 0,
        length: m[0]!.length,
          label: m[0]!,
          to,
          toSection: null,
          method: to ? "heuristic" : "unresolved",
          confidence: to ? 0.85 : 0.25,
          signals: [{ kind: "author-date" }],
        });
        if (!to) unresolved.push({ label: m[0]!, from: b.id, reason: "no bibliography entry matched" });
      }
    }
  }

  // -- reconciliation: recognition, destination validation, competing ranges --
  // Detectors above only proposed candidates; the final model comes from here.
  const { refs: reconciled, records } = reconcile(refs, { blocks, structure, systems, entries });

  // Sibling ranges inside one node must stay independently selectable.
  const disjoint = disjoinRanges(
    reconciled.map(({ signals: _s, exact: _e, ...r }) => ({ ...r, from: r.marker.blockId, confidence: r.confidence, exact: exactIds.has(r.id) })),
    (id) => blockById.get(id)?.text ?? "",
  ).map(({ exact: _exact, ...r }) => ({
    ...r,
    at: r.marker.start,
    sourceText: (blockById.get(r.marker.blockId)?.text ?? "").slice(r.marker.start, r.marker.end),
  }));
  const out: RefEdge[] = disjoint;

  // keep the graph deterministic
  out.sort((a, b) => (a.from === b.from ? a.at - b.at : a.from.localeCompare(b.from, "en")));
  // the unresolved list reflects the reconciled model, not raw detector output
  const finalUnresolved = out
    .filter((r) => !r.to && !r.toSection)
    .map((r) => ({
      label: r.label,
      from: r.from,
      reason: r.ambiguous ? "several destinations are plausible" : r.note ?? r.evidence[r.evidence.length - 1] ?? "no destination found",
    }));
  void unresolved;
  void blockById;
  void systemById;
  return { refs: out, unresolved: finalUnresolved, recognition: records, census };
}
