// Exact inline anchoring helpers.
//
// A reference is a character range, never "a block that contains a reference".
// These helpers turn an editorial lemma (the catchphrase an apparatus entry
// quotes) into the exact span it occupies in the normalized reading text, and
// keep sibling ranges inside one node disjoint so each can be selected alone.

interface Normalized {
  norm: string;
  /** normalized index -> original start offset */
  start: number[];
  /** normalized index -> original end offset (exclusive) */
  end: number[];
}

/** Lowercase, fold every non-alphanumeric run to a single space, keep an offset map. */
function normalize(text: string): Normalized {
  const norm: string[] = [];
  const start: number[] = [];
  const end: number[] = [];
  let space = true; // suppress a leading space
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (/[\p{L}\p{N}]/u.test(ch)) {
      norm.push(ch.toLowerCase());
      start.push(i);
      end.push(i + 1);
      space = false;
    } else if (!space) {
      norm.push(" ");
      start.push(i);
      end.push(i + 1);
      space = true;
    }
  }
  while (norm.length && norm[norm.length - 1] === " ") {
    norm.pop();
    start.pop();
    end.pop();
  }
  return { norm: norm.join(""), start, end };
}

export interface Span {
  start: number;
  end: number;
  /** fraction of the lemma's words that were matched */
  coverage: number;
}

/**
 * Locate the complete referenced expression inside `text`.
 *
 * The lemma is matched whole first; only when the edition's wording and the
 * reading text differ (elision, a quotation mark the parser folded away) does
 * this fall back to progressively shorter word windows, always reporting how
 * much of the phrase was actually covered so callers can score it.
 */
export function phraseSpan(text: string, lemma: string): Span | null {
  if (!lemma.trim()) return null;
  const t = normalize(text);
  const l = normalize(lemma);
  if (!l.norm) return null;
  const words = l.norm.split(" ").filter(Boolean);
  if (!words.length) return null;

  for (let len = words.length; len >= 1; len--) {
    for (let off = 0; off + len <= words.length; off++) {
      const needle = words.slice(off, off + len).join(" ");
      if (needle.length < 3 && len < words.length) continue;
      const at = t.norm.indexOf(needle);
      if (at < 0) continue;
      // do not match inside a longer word
      const before = at > 0 ? t.norm[at - 1] : " ";
      const after = at + needle.length < t.norm.length ? t.norm[at + needle.length] : " ";
      if (before !== " " || after !== " ") continue;
      return {
        start: t.start[at]!,
        end: t.end[at + needle.length - 1]! ,
        coverage: len / words.length,
      };
    }
  }
  return null;
}

/** A short opening span used when an entry prints no quotable lemma. */
export function openingSpan(text: string, maxWords = 4): Span | null {
  const m = text.match(/^\s*/);
  const from = m ? m[0].length : 0;
  if (from >= text.length) return null;
  let words = 0;
  let i = from;
  for (; i < text.length && words < maxWords && i - from < 48; i++) {
    if (/\s/.test(text[i]!) && i > from) {
      words++;
      if (words >= maxWords) break;
    }
  }
  const end = Math.max(from + 1, i);
  return { start: from, end, coverage: 0 };
}

export interface Ranged {
  from: string;
  marker: { start: number; end: number };
  confidence: number;
  /** an exact source marker: its range is verbatim and must never be re-snapped */
  exact?: boolean;
}

/**
 * A reference *marker* — the printed token that stands for the reference —
 * rather than the words it happens to sit next to.
 *
 * "[6]", "(6)", "6", "*", "†", "1.136–40" are markers; "Elizabeth's sense and
 * conduct" is source content that a marker may be attached to.
 */
const MARKER_CORE =
  /^[[(<{]?\s*((?:\d{1,4}(?:\s*[.:]\s*\d{1,4})*(?:\s*[–—-]\s*\d{1,4})?)|[*†‡§¶#]{1,3}|[a-z])\s*[\])>}]?[.,;:]?$/i;

/** True when an anchor string reads as a reference marker, not as prose. */
export function isMarkerLike(anchor: string): boolean {
  return MARKER_CORE.test(anchor.trim());
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Locate a reference marker in `text` and return its *complete* range,
 * including the brackets or parentheses that are part of the printed marker.
 *
 * Unlike `phraseSpan`, this never widens onto the neighbouring word: a marker
 * adjacent to a word ("conduct[6]") anchors on "[6]" alone.
 */
export function markerSpan(text: string, anchor: string, from = 0): Span | null {
  const m = anchor.trim().match(MARKER_CORE);
  if (!m) return null;
  const core = m[1]!.replace(/\s+/g, "");
  // allow the printed marker to space its own inner punctuation
  const body = escapeRe(core).replace(/\\?([.:–—-])/g, "\\s*$1\\s*");
  const re = new RegExp(
    `([[(<{]\\s*${body}\\s*[\\])>}])|((?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}]))`,
    "gu",
  );
  let bare: Span | null = null;
  re.lastIndex = Math.max(0, from);
  for (let hit = re.exec(text); hit; hit = re.exec(text)) {
    const span: Span = { start: hit.index, end: hit.index + hit[0].length, coverage: 1 };
    if (hit[1]) return span; // a bracketed marker is the complete marker
    bare ??= span;
  }
  return bare;
}

/**
 * Locate the text a link annotation covers *verbatim* in the reading text.
 *
 * When the file itself tells us which characters are linked, that range is the
 * reference — it is never widened to the surrounding words, sentence or block,
 * and never shortened. The only tolerance is for text the source broke across
 * lines: the annotation's covered characters may carry the line break (and the
 * hyphen that went with it) where the reading text carries a single space.
 */
export function literalSpan(text: string, anchor: string, from = 0): Span | null {
  const a = anchor.trim();
  if (!a) return null;
  const at = text.indexOf(a, Math.max(0, from));
  if (at >= 0) return { start: at, end: at + a.length, coverage: 1 };
  // A word the source hyphenated at a line break is rejoined in the reading
  // text, so the break itself — hyphen included — is what may differ.
  const parts = a.split(/[-\u2010\u00ad]?\s+/).filter(Boolean).map(escapeRe);
  if (parts.length < 2) return null;
  const re = new RegExp(parts.join("(?:[-\\u2010\\u00ad]?\\s+)?"), "u");
  const hit = re.exec(text.slice(Math.max(0, from)));
  if (!hit) return null;
  const start = Math.max(0, from) + hit.index;
  return { start, end: start + hit[0].length, coverage: 1 };
}

const WORD = /[\p{L}\p{N}]/u;

/**
 * Pull a range back onto whole-word, non-punctuation boundaries.
 *
 * Trimming an overlap can land a boundary inside a word ("…Zeu|s, share…",
 * "…Achae|ans"), which reads as a parser error. Snapping only ever shrinks the
 * range, so ranges that were disjoint stay disjoint.
 */
export function snapToWords(
  text: string,
  start: number,
  end: number,
  trimEdges = true,
): { start: number; end: number } | null {
  let s = Math.max(0, Math.min(start, text.length));
  let e = Math.max(s, Math.min(end, text.length));
  // mid-word start -> move forward past the rest of that word
  if (s > 0 && WORD.test(text[s - 1] ?? "") && WORD.test(text[s] ?? "")) {
    while (s < e && WORD.test(text[s] ?? "")) s++;
  }
  // mid-word end -> move back to the start of that word
  if (e < text.length && WORD.test(text[e - 1] ?? "") && WORD.test(text[e] ?? "")) {
    while (e > s && WORD.test(text[e - 1] ?? "")) e--;
  }
  // never leave whitespace hanging off either edge
  while (s < e && /\s/.test(text[s] ?? "")) s++;
  while (e > s && /\s/.test(text[e - 1] ?? "")) e--;
  if (trimEdges) {
    // a trimmed range may end on a stray comma or dash: drop it
    while (e > s && /[.,;:—–-]/.test(text[e - 1] ?? "")) e--;
    while (s < e && /[.,;:—–-]/.test(text[s] ?? "")) s++;
    while (s < e && /\s/.test(text[s] ?? "")) s++;
    while (e > s && /\s/.test(text[e - 1] ?? "")) e--;
  }
  if (e - s < 1) return null;
  return { start: s, end: e };
}

/**
 * Keep sibling ranges inside one node disjoint.
 *
 * Three references in one paragraph must be three independently selectable
 * ranges; when two anchors collide the weaker one is trimmed off the stronger,
 * and dropped only if nothing selectable is left.
 */
export function disjoinRanges<T extends Ranged>(refs: T[], textOf?: (nodeId: string) => string): T[] {
  const byNode = new Map<string, T[]>();
  for (const r of refs) {
    const arr = byNode.get(r.from) ?? [];
    arr.push(r);
    byNode.set(r.from, arr);
  }
  const drop = new Set<T>();
  for (const [nodeId, arr] of byNode) {
    if (arr.length < 2) continue;
    const text = textOf?.(nodeId) ?? "";
    // exact source markers win every collision: their range is the printed token
    const ordered = [...arr].sort(
      (a, b) =>
        Number(!!b.exact) - Number(!!a.exact) ||
        b.confidence - a.confidence ||
        a.marker.start - b.marker.start,
    );
    const taken: { start: number; end: number }[] = [];
    for (const r of ordered) {
      let { start, end } = r.marker;
      let trimmed = false;
      if (r.exact) {
        taken.push({ start, end });
        continue;
      }
      for (const t of taken) {
        if (end <= t.start || start >= t.end) continue;
        if (start < t.start) {
          end = Math.min(end, t.start);
          trimmed = true;
        } else if (end > t.end) {
          start = Math.max(start, t.end);
          trimmed = true;
        } else {
          start = end = -1;
          break;
        }
      }
      if (start < 0 || end - start < 1) {
        drop.add(r);
        continue;
      }
      if (text) {
        const snapped = snapToWords(text, start, end, trimmed);
        if (!snapped) {
          drop.add(r);
          continue;
        }
        start = snapped.start;
        end = snapped.end;
      }
      r.marker.start = start;
      r.marker.end = end;
      taken.push({ start, end });
    }
  }
  return refs.filter((r) => !drop.has(r));
}

