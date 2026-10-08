// Reference-marker identity.
//
// A note system is not assumed to be numbered. A printed marker can be a
// number, a symbol (*, †, ‡, §, ¶ and their doublings), a letter or a Roman
// numeral. This module only says what class a token belongs to and what its
// identity is; whether a token *is* a reference is decided elsewhere, from
// evidence that it participates in a system with a matching destination.

export type MarkerClass = "numeric" | "symbol" | "alphabetic" | "roman";

export const SYMBOL_CHARS = "*†‡§¶";

const SYMBOL_RE = /^(?:\*{1,3}|†{1,3}|‡{1,3}|§{1,3}|¶{1,3})$/;
const ROMAN_RE = /^(?=[ivxlc])(?:c{0,3})(?:xc|xl|l?x{0,3})(?:ix|iv|v?i{0,3})$/;

/** Strip the brackets, parentheses and closing period that frame a printed marker. */
export function markerKey(token: string): string {
  const core = token.trim().replace(/^[[(<{]\s*/, "").replace(/\s*[\])>}]?[.:]?$/, "").trim();
  return /^[A-Za-z]+$/.test(core) ? core.toLowerCase() : core;
}

/**
 * Class of a normalized marker key, or null when the token cannot be a marker.
 * Single letters that are also Roman numerals ("i", "v", "x") report as roman;
 * identity matching compares keys, so the class never decides a destination.
 */
export function markerClass(key: string): MarkerClass | null {
  if (!key) return null;
  if (/^\d{1,3}$/.test(key)) return "numeric";
  if (SYMBOL_RE.test(key)) return "symbol";
  const k = key.toLowerCase();
  if (k.length <= 6 && ROMAN_RE.test(k)) return "roman";
  if (/^[a-z]$/.test(k)) return "alphabetic";
  return null;
}

/**
 * A symbol glued to the end of a word or closing punctuation ("word†",
 * "said.*"). This is only a *candidate*: a glued symbol becomes a reference
 * solely when a note system with that exact key exists.
 */
export const GLUED_SYMBOL = /(?<=[\p{L}\p{N}.,;:!?'"’”)\]])(\*{1,3}|†{1,3}|‡{1,3}|§{1,3}|¶{1,3})(?![\p{L}\p{N}*†‡§¶])/gu;
