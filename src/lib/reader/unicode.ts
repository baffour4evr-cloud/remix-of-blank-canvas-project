// Character-level repair applied to every span the extractor produces.
//
// PDF text operators emit presentation forms (ligature glyphs, decomposed
// accents, non-breaking spaces) that are correct for printing but wrong for a
// reflowable reading document: they break search, sentence segmentation and
// word joining. Everything downstream assumes text that has already passed
// through here.

const LIGATURES: Record<string, string> = {
  "\uFB00": "ff",
  "\uFB01": "fi",
  "\uFB02": "fl",
  "\uFB03": "ffi",
  "\uFB04": "ffl",
  "\uFB05": "st",
  "\uFB06": "st",
  "\u0132": "IJ",
  "\u0133": "ij",
};

/** Undecodable glyph placeholders emitted by pdf.js when a font has no ToUnicode map. */
export const UNDECODABLE = /[\u0000\uFFFD]/;

export function normalizeText(input: string): string {
  if (!input) return input;
  let t = input;
  // canonical composition first: "i" + U+0308 + U+0301 -> "ḯ"
  t = t.normalize("NFC");
  if (/[\uFB00-\uFB06\u0132\u0133]/.test(t)) t = t.replace(/[\uFB00-\uFB06\u0132\u0133]/g, (c) => LIGATURES[c] ?? c);
  // invisible characters that only exist to control PDF line breaking
  t = t.replace(/[\u00AD\u200B-\u200D\u2060\uFEFF]/g, "");
  // exotic spaces -> a plain space
  t = t.replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, " ");
  return t;
}

// ---------------------------------------------------------------------------
// Whitespace recovery
// ---------------------------------------------------------------------------

const LETTER = "A-Za-z\\u00C0-\\u024F\\u0370-\\u03FF";

/**
 * Re-insert the word space a PDF/OCR extractor swallowed at a punctuation
 * boundary ("Michaelmas,and", "year.What").
 *
 * Purely structural: a space is only added where punctuation is immediately
 * followed by a letter that cannot belong to the same token. Digit groups
 * ("1,000"), initials ("J.D.") and decimals are excluded by construction
 * because the rules require a letter on at least one side and, for the
 * sentence punctuation, a lower-case letter before and a capital after.
 */
export function fixGluedPunctuation(input: string): string {
  if (!input) return input;
  let t = input;
  // comma / semicolon / colon glued to the next word
  t = t.replace(new RegExp(`([,;:])(?=[${LETTER}])`, "g"), "$1 ");
  // sentence end glued to the next sentence: needs lower-case before, capital after
  t = t.replace(
    new RegExp(`([a-z\\u00DF-\\u024F\\u2019'”"])([.!?]+)(?=["“'\\u2018]?[A-Z\\u00C0-\\u00DE])`, "g"),
    "$1$2 ",
  );
  // closing quote glued to the next word
  t = t.replace(new RegExp(`([”\\u2019])(?=[${LETTER}])`, "g"), "$1 ");
  return t;
}

