// Sentence / semantic-unit segmentation.
//
// This runs on NORMALIZED block text only — never on raw PDF text boxes. By the
// time a block reaches this module, PDF line wrapping has already been folded
// away by content.ts, so a sentence that the PDF broke across four physical
// lines is one contiguous string here.

/** Abbreviations whose trailing period does not end a sentence. */
const ABBREV = new Set([
  "mr", "mrs", "ms", "dr", "prof", "st", "sr", "jr", "vs", "etc", "e.g", "i.e", "cf",
  "fig", "no", "vol", "vols", "ed", "eds", "trans", "ch", "chap", "p", "pp", "ll", "l",
  "c", "ca", "cent", "fl", "d", "b", "bc", "ad", "ff", "n", "nn", "esp", "viz", "op",
  "cit", "ibid", "al", "gr", "lat", "sc",
]);

const CLOSERS = `"'”’)\\]»`;

function isAbbreviationBefore(text: string, dotIndex: number): boolean {
  let i = dotIndex - 1;
  let word = "";
  while (i >= 0 && /[A-Za-z.]/.test(text[i]!)) {
    word = text[i]! + word;
    i--;
  }
  if (!word) return false;
  const bare = word.replace(/\.$/, "").toLowerCase();
  if (ABBREV.has(bare)) return true;
  // single initials: "J. R. R. Tolkien", and dotted acronyms "U.S."
  if (/^[A-Za-z]$/.test(word)) return true;
  if (/^([A-Za-z]\.)+[A-Za-z]$/.test(word)) return true;
  // short work-sigla before a locus: "Od. 1.10", "Il. 24.5"
  if (bare.length <= 4 && /^\s*\d/.test(text.slice(dotIndex + 1))) return true;
  return false;
}


/**
 * Split normalized text into sentence ranges. Never returns an empty list: a
 * fragment with no terminal punctuation is one sentence covering the whole text.
 */
export function sentenceRanges(text: string): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch !== "." && ch !== "!" && ch !== "?" && ch !== "…") continue;
    if (ch === "." && isAbbreviationBefore(text, i)) continue;
    if (ch === "." && /\d/.test(text[i - 1] ?? "") && /\d/.test(text[i + 1] ?? "")) continue; // 1.10
    // absorb repeated terminals, closing quotes/brackets, and any note marker
    // that the edition prints after the stop ("… mortified.[3] She said …")
    let j = i + 1;
    while (j < text.length && /[.!?…]/.test(text[j]!)) j++;
    while (j < text.length && new RegExp(`[${CLOSERS}]`).test(text[j]!)) j++;
    const marker = /^(?:\[\d{1,3}\]|\d{1,3}\b(?=\s+[A-Z“"'(])|[*†‡§]+)/.exec(text.slice(j));
    if (marker) j += marker[0].length;

    const after = text.slice(j, j + 3);
    // a sentence ends when whitespace + something that can open a sentence follows
    if (j < text.length && !/^\s/.test(after)) continue;
    const rest = text.slice(j).replace(/^\s+/, "");
    if (rest && !/^[A-Z“"'(\[0-9—–]/.test(rest) && !/^[a-z]{0,2}$/.test(rest)) continue;
    const end = j;
    if (end > start) out.push({ start, end });
    start = j + (text.length > j ? text.slice(j).length - text.slice(j).replace(/^\s+/, "").length : 0);
    i = start - 1;
  }
  if (start < text.length) out.push({ start, end: text.length });
  if (!out.length) out.push({ start: 0, end: text.length });
  return out;
}

/** The complete sentence containing `at`. */
export function sentenceAt(text: string, at: number): { start: number; end: number } {
  const ranges = sentenceRanges(text);
  for (const r of ranges) if (at >= r.start && at < r.end) return r;
  return ranges[ranges.length - 1] ?? { start: 0, end: text.length };
}
