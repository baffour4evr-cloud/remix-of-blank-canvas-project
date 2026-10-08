/**
 * Raw source-evidence contract.
 *
 * This layer is an *observation* of the PDF. It performs no character
 * correction, no font guessing, no Unicode substitution, no small-caps
 * conversion, no paragraph reconstruction and no semantic interpretation.
 * Every value here is either reported directly by the extraction engine or is
 * geometry arithmetic over reported numbers (and then labelled as such).
 *
 * It is deliberately format-agnostic and serializable so a `SourceDoc` can be
 * persisted beside the normalized model and re-inspected later.
 */

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Stable identity of one font *as used in one document*, subset included. */
export interface FontRef {
  /** stable id: the engine's per-document font handle (unique per font AND subset) */
  id: string;
  /** the handle exactly as the engine reported it */
  handle: string;
  /** PostScript / base font name as reported ("ABCDEF+Garamond-Regular") */
  psName: string;
  /** family the engine reports for rendering ("serif", "Garamond") */
  family: string;
  /** the six-letter subset tag of `psName`, when the file carries one */
  subset: string | null;
  /** PDF font subtype, when the engine exposes it */
  subtype: string | null;
  /**
   * Style flags exactly as reported by the engine. `null` means "not reported"
   * — never inferred from the name, size or appearance of the text.
   */
  flags: {
    bold: boolean | null;
    italic: boolean | null;
    black: boolean | null;
    vertical: boolean | null;
    type3: boolean | null;
    /** the engine could not load an embedded program for this font */
    missingFile: boolean | null;
  };
  /** an embedded font program was available to the engine */
  hasEmbeddedProgram: boolean | null;
  ascent: number | null;
  descent: number | null;
  /** font bounding box in glyph space, when reported */
  bbox: number[] | null;
}

/** How a character's geometry was obtained. Text is never affected by this. */
export type CharGeometrySource =
  /** origin + box computed from the run origin and the glyph's own advance */
  | "glyph-advance"
  /** only the run origin was known; the box is the run box */
  | "run-origin"
  | "none";

/** Which mapping the engine says produced the Unicode value. */
export type UnicodeSource =
  /** pdf.js-resolved mapping (/ToUnicode, embedded cmap or built-in encoding — it does not say which) */
  | "engine-mapped"
  /** the text layer produced a character the glyph stream never contained */
  | "engine-synthesized"
  | "ocr";

export interface SourceChar {
  /** index of this character within its page, in extraction order */
  i: number;
  /** the extracted Unicode character, exactly as reported. Never modified. */
  ch: string;
  /** content-stream character code, when exposed */
  code: number | null;
  /** glyph id, when exposed (pdf.js does not expose it; kept for other engines) */
  gid: number | null;
  /** the embedded font program's own glyph character, when exposed */
  fontChar: string | null;
  /** combining accent the engine attached to this glyph, when any */
  accent: string | null;
  /** engine says this glyph is a space glyph */
  isSpaceGlyph: boolean | null;
  /** engine found the glyph in the font program */
  inFont: boolean | null;
  /** advance width in text space (glyph units scaled by the run's size) */
  advance: number | null;
  /** baseline origin in PDF user space */
  origin: { x: number; y: number } | null;
  bbox: Box | null;
  geometry: CharGeometrySource;
  unicodeSource: UnicodeSource;
  /** font identity this character was drawn with */
  fontId: string;
  /** font size in effect */
  size: number;
  /** index of the run this character belongs to */
  run: number;
  /** id of a link annotation whose rectangle covers this character */
  link: string | null;
  /** extraction confidence, when the producer has one (OCR only) */
  confidence?: number;
}

/** One engine-reported text span (a pdf.js text item), with its characters. */
export interface SourceRun {
  /** index of the run within the page, in extraction order */
  order: number;
  fontId: string;
  size: number;
  /** the run's own reported text, untouched */
  text: string;
  chars: SourceChar[];
  bbox: Box;
  origin: { x: number; y: number };
  /** engine reported a line break after this run */
  hasEOL: boolean;
  /** total reported width of the run */
  width: number;
}

export interface SourceLink {
  id: string;
  rect: Box;
  url: string | null;
  destPage: number | null;
  destY: number | null;
  /** half-open range of page character indices the rectangle covers */
  charRange: { start: number; end: number } | null;
  /** text the engine says the annotation overlays, when it reports it */
  overlaidText: string | null;
}

export interface SourceImage {
  bbox: Box;
  kind: string;
}

export interface SourcePage {
  page: number;
  width: number;
  height: number;
  rotation: number;
  runs: SourceRun[];
  links: SourceLink[];
  images: SourceImage[];
  /** how the page's text was obtained */
  method: "native" | "ocr" | "empty";
  ocr?: { meanConfidence: number };
}

export interface SourceDocMeta {
  title: string | null;
  author: string | null;
  /** every other info-dictionary key the engine reported, unmodified */
  info: Record<string, string>;
}

export interface SourceOutlineEntry {
  title: string;
  page: number | null;
  depth: number;
}

export interface SourceDoc {
  /** contract version, so persisted artifacts can be migrated */
  version: 1;
  /** which producer generated this document */
  producer: string;
  pageCount: number;
  meta: SourceDocMeta;
  outline: SourceOutlineEntry[];
  /** every font identity seen, keyed by `FontRef.id` */
  fonts: Record<string, FontRef>;
  pages: SourcePage[];
}

/** Flatten a page's characters in extraction order. */
export function pageChars(page: SourcePage): SourceChar[] {
  return page.runs.flatMap((r) => r.chars);
}

/** The page's extracted text, as a plain concatenation of its evidence. */
export function pageText(page: SourcePage): string {
  return page.runs.map((r) => r.text).join("");
}
