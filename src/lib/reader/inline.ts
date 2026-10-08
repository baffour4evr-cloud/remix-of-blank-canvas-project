import type { Block, RefEdge, Run, TextRange } from "./types";

export type InlineKind =
  | "text"
  | "emphasis"
  | "strong"
  | "small-caps"
  | "superscript"
  | "subscript"
  | "inline-code"
  | "hyperlink"
  | "reference-marker";

export interface ReaderInline {
  type: InlineKind;
  text: string;
  range: TextRange;
  sources: { page: number; o: number }[];
  em?: boolean;
  strong?: boolean;
  sc?: boolean;
  sup?: boolean;
  sub?: boolean;
  code?: boolean;
  ref?: RefEdge;
}

export interface ReaderBlock {
  block: Block;
  inline: ReaderInline[];
}

interface RunRange {
  start: number;
  end: number;
  run: Run;
}

interface RefRange {
  start: number;
  end: number;
  ref: RefEdge;
}

/**
 * Maps each normalized run onto a character range of the block's own text.
 *
 * The block text is authoritative: inline text is always sliced from it, never
 * rebuilt from runs, so no normalization, case or Unicode change can occur
 * here. When runs concatenate to the block text exactly (the normal case) the
 * offsets are purely cumulative; otherwise each run is located by a
 * forward-only scan so formatting can never be attributed backwards.
 */
function rangesForRuns(block: Block): RunRange[] {
  const runs = block.runs ?? [];
  const text = typeof block.text === "string" ? block.text : "";
  const ranges: RunRange[] = [];
  const joined = runs.map((run) => run.t ?? "").join("");
  if (joined === text) {
    let cursor = 0;
    for (const run of runs) {
      const len = (run.t ?? "").length;
      if (len > 0) ranges.push({ start: cursor, end: cursor + len, run });
      cursor += len;
    }
    return ranges;
  }
  let cursor = 0;
  for (const run of runs) {
    if (!run.t) continue;
    let start = cursor;
    if (!text.startsWith(run.t, start)) {
      const found = text.indexOf(run.t, start);
      if (found < 0) continue;
      start = found;
    }
    const end = Math.min(text.length, start + run.t.length);
    if (end > start) ranges.push({ start, end, run });
    cursor = end;
  }
  return ranges;
}

function isReferenceMarker(ref: RefEdge): boolean {
  if (ref.provenance === "explicit-link") return false;
  if (ref.method === "link") return false;
  return true;
}

function kindFor(run: Run | undefined, ref: RefEdge | undefined): InlineKind {
  if (ref) return isReferenceMarker(ref) ? "reference-marker" : "hyperlink";
  if (run?.code) return "inline-code";
  if (run?.sup) return "superscript";
  if (run?.sub) return "subscript";
  if (run?.strong) return "strong";
  if (run?.em) return "emphasis";
  if (run?.sc) return "small-caps";
  return "text";
}

/**
 * Reference ranges belonging to this block, measured on normalized text only.
 * Ranges are preserved exactly as the reference layer supplied them — never
 * trimmed to a literal token, never recomputed from layout — and overlapping
 * edges are resolved deterministically so one range can never absorb another's
 * text.
 */
function rangesForRefs(block: Block, refs: RefEdge[]): RefRange[] {
  const seen = new Set<string>();
  const candidates: RefRange[] = [];
  for (const ref of refs) {
    if (ref.marker.blockId !== block.id && ref.from !== block.id) continue;
    if (ref.marker.blockId !== block.id) continue;
    if (seen.has(ref.id)) continue;
    seen.add(ref.id);
    const start = Math.max(0, Math.min(ref.marker.start, block.text.length));
    const end = Math.max(0, Math.min(ref.marker.end, block.text.length));
    if (end > start) candidates.push({ start, end, ref });
  }
  candidates.sort((a, b) => a.start - b.start || b.end - a.end);
  const taken: RefRange[] = [];
  for (const range of candidates) {
    if (taken.some((t) => range.start < t.end && t.start < range.end)) continue;
    taken.push(range);
  }
  return taken.sort((a, b) => a.start - b.start);
}

function runAt(runRanges: RunRange[], start: number, end: number): Run | undefined {
  return (
    runRanges.find((range) => range.start <= start && range.end >= end)?.run ??
    runRanges.find((range) => start < range.end && range.start < end)?.run
  );
}

function nodeFor(block: Block, text: string, start: number, end: number, run: Run | undefined, ref: RefEdge | undefined): ReaderInline {
  return {
    type: kindFor(run, ref),
    text: text.slice(start, end),
    range: { blockId: block.id, start, end },
    sources: [...(run?.sources ?? block.prov?.sources ?? [])],
    ...(run?.em ? { em: true } : {}),
    ...(run?.strong ? { strong: true } : {}),
    ...(run?.sc ? { sc: true } : {}),
    ...(run?.sup ? { sup: true } : {}),
    ...(run?.sub ? { sub: true } : {}),
    ...(run?.code ? { code: true } : {}),
    ...(ref ? { ref } : {}),
  };
}

function sameFormatting(a: ReaderInline, b: ReaderInline): boolean {
  return (
    a.ref === b.ref &&
    a.type === b.type &&
    !!a.em === !!b.em &&
    !!a.strong === !!b.strong &&
    !!a.sc === !!b.sc &&
    !!a.sup === !!b.sup &&
    !!a.sub === !!b.sub &&
    !!a.code === !!b.code
  );
}

/**
 * Converts one authoritative semantic block into one reader block with ordered
 * inline children. A reference range stays a single inline node even when the
 * source split it across runs or PDF lines; source coordinates are provenance
 * and never influence reader layout.
 */
export function toReaderBlock(block: Block, refs: RefEdge[] = []): ReaderBlock {
  const text = typeof block.text === "string" ? block.text : "";
  const runRanges = rangesForRuns(block);
  const refRanges = rangesForRefs(block, refs);

  const inline: ReaderInline[] = [];
  const pushText = (from: number, to: number) => {
    if (to <= from) return;
    const cuts = new Set<number>([from, to]);
    for (const range of runRanges) {
      if (range.start > from && range.start < to) cuts.add(range.start);
      if (range.end > from && range.end < to) cuts.add(range.end);
    }
    const sorted = [...cuts].sort((a, b) => a - b);
    for (let i = 0; i < sorted.length - 1; i++) {
      const start = sorted[i] ?? from;
      const end = sorted[i + 1] ?? to;
      if (end <= start) continue;
      const node = nodeFor(block, text, start, end, runAt(runRanges, start, end), undefined);
      const last = inline[inline.length - 1];
      if (last && sameFormatting(last, node) && last.range.end === start) {
        last.text += node.text;
        last.range = { blockId: block.id, start: last.range.start, end };
        for (const source of node.sources) {
          if (!last.sources.some((s) => s.page === source.page && s.o === source.o)) last.sources.push(source);
        }
      } else inline.push(node);
    }
  };

  let cursor = 0;
  for (const range of refRanges) {
    pushText(cursor, range.start);
    inline.push(nodeFor(block, text, range.start, range.end, runAt(runRanges, range.start, range.end), range.ref));
    cursor = range.end;
  }
  pushText(cursor, text.length);

  return { block, inline };
}

export function inlineText(readerBlock: ReaderBlock): string {
  return readerBlock.inline.map((node) => node.text).join("");
}
