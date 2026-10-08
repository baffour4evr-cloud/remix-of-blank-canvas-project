// Shared document model. Deliberately format-agnostic: the PDF importer is one
// producer of RawDoc, EPUB3/DOCX importers can be added later without touching
// anything downstream of `analyze()`.

/**
 * One positioned span of source text.
 *
 * `t` is the working (derived) text every later stage reads. The source
 * evidence — the exact string the file produced, its font identity, its box and
 * its position in reading order — is kept alongside it and is never
 * overwritten, so semantic stages can always inspect what the PDF contained.
 */
export interface RawItem {
  x: number;
  y: number;
  w: number;
  s: number;
  f: string;
  t: string;
  /** exact extracted Unicode, before any normalization or repair */
  t0?: string;
  /** position of this span in the page's reading order, as extracted */
  o?: number;
  /** font family reported by the file, when it names one */
  fam?: string;
  /** glyph box height in PDF user space */
  h?: number;
  /** how `t` came to differ from `t0` — evidence, not a reading instruction */
  repair?:
    | "unicode"
    | "glyph-map"
    | "glyph-code"
    | "encoding-offset"
    | "to-unicode"
    | "font-char"
    | "char-code"
    | "glyph-alphabet"
    /** read off the rendered glyphs because the font supplied no mapping at all */
    | "glyph-ocr";
  /** provenance of a font/encoding repair: which mapping, on what evidence */
  map?: {
    kind: string;
    authoritative: boolean;
    confidence: number;
    evidence: string;
    font: string;
  };
  /** the font looks mis-mapped but no mapping was confident enough to apply */
  uncertain?: boolean;
  /** the span is set in small capitals — typography, never a change of letters */
  sc?: boolean;
  /** the span's font reports italic — read from the font, never inferred */
  em?: boolean;
  /** the span's font reports bold/heavy weight */
  strong?: boolean;
  /** the span's font is fixed-pitch */
  mono?: boolean;
  /** number of characters the file supplied no usable Unicode mapping for */
  unmapped?: number;
  /** OCR confidence in [0,1]; absent for spans read from a PDF text layer */
  conf?: number;
}


export interface RawLink {
  x: number;
  y: number;
  w: number;
  h: number;
  destPage: number | null;
  /** vertical position of the destination inside its page, in PDF user space */
  destY?: number | null;
  url: string | null;
  /** the text the link annotation covers, read off the page's own spans */
  text?: string;
  /** the annotation's own identity, as reported by the extraction engine */
  id?: string;
  /** the exact character range of the page's text the annotation covers */
  charRange?: { start: number; end: number } | null;
}


export interface RawPage {
  page: number;
  width: number;
  height: number;
  items: RawItem[];
  links: RawLink[];
  /** how this page's text was obtained — the pipeline downstream never cares */
  method?: "native" | "ocr" | "empty";
  /** OCR statistics, when the page came from OCR */
  ocr?: { meanConfidence: number; words: number; lowConfidenceWords: number; error?: string };
}

export interface RawOutlineEntry {
  title: string;
  page: number | null;
  depth: number;
}

export interface RawDoc {
  pageCount: number;
  meta: { title?: string | undefined; author?: string | undefined };
  outline: RawOutlineEntry[];
  pages: RawPage[];
}

// ---------------------------------------------------------------------------
// Normalized document
// ---------------------------------------------------------------------------

export interface Run {
  t: string;
  em?: boolean;
  strong?: boolean;
  sup?: boolean;
  sub?: boolean;
  code?: boolean;
  /** set in small caps in the source */
  sc?: boolean;
  /** id of a reference edge anchored on this run */
  ref?: string;
  /** source spans that supplied this run; coordinates remain block-level evidence */
  sources?: { page: number; o: number }[];
}


export type BlockType =
  | "heading"
  | "paragraph"
  | "verse-line"
  | "verse-space"
  | "entry"
  | "caption"
  /** prose set inside a quotation block (indented on both margins, or set smaller) */
  | "blockquote"
  /** a paragraph of an embedded document (a letter, a notice, a transcript) */
  | "letter"
  /** one item of a bulleted or numbered list */
  | "list-item";

/** Where a normalized node came from in the source file (provenance only). */
export interface Provenance {
  /** source page of the node's first line */
  page: number;
  /** every source page the node's lines came from */
  pages: number[];
  /** union bounding box per page, in PDF user space */
  boxes: { page: number; x: number; y: number; w: number; h: number }[];
  /** number of physical source lines folded into this node */
  lines: number;
  /** the source spans, in order, whose characters produced this node's text */
  sources?: { page: number; o: number }[];
  /** how the source text was obtained */
  method?: "native" | "ocr" | "empty";
  /** mean OCR confidence of the node's source page, when OCR'd */
  conf?: number;
}

export interface Block {
  id: string;
  page: number;
  type: BlockType;
  level?: number;
  /** structure node this block belongs to */
  section: string;
  runs: Run[];
  text: string;
  /** verse line number, when known */
  line?: number;
  /** entry key for apparatus entries ("517", "3.109", "12") */
  key?: string;
  /** apparatus system id for entry blocks */
  system?: string;
  /** the lemma (quoted catchphrase) of a lemma-keyed entry */
  lemma?: string;
  /** where this node came from in the PDF — debugging/provenance, never reading */
  prov?: Provenance;
  /** id shared by every paragraph of one embedded region (a single letter, one quotation) */
  group?: string;
  /** first / last paragraph of its group, so the renderer can frame the region */
  groupEdge?: "start" | "end" | "only";
  /** why the block was classified into an embedded structure — evidence, not layout */
  groupWhy?: string;
}

/** Every block type that carries running reading text. */
export const PROSE_BLOCK_TYPES: BlockType[] = ["paragraph", "blockquote", "letter", "list-item"];

export function isProse(t: BlockType): boolean {
  return PROSE_BLOCK_TYPES.includes(t);
}

/** A half-open character range inside one normalized block's `text`. */
export interface TextRange {
  blockId: string;
  start: number;
  end: number;
}


export type StructureType =
  | "root"
  | "volume"
  | "book"
  | "part"
  | "chapter"
  | "section"
  | "appendix"
  | "apparatus"
  | "frontmatter";

export interface StructureNode {
  id: string;
  type: StructureType;
  /** "Book 9", "Chapter XXII" */
  label: string;
  /** normalized numeric value of the label, when it has one */
  number: number | null;
  title: string;
  page: number;
  parent: string | null;
  depth: number;
  /** index into blocks[] where this node's content starts */
  start: number;
  end: number;
  /** true when the section's body is verse */
  verse?: boolean;
}

export type SystemKind =
  | "footnote"
  | "endnote"
  | "editorial-note"
  | "translator-note"
  | "line-commentary"
  | "textual-apparatus"
  | "bibliography"
  | "glossary"
  | "appendix"
  | "essay"
  | "illustration"
  | "line-numbering"
  | "internal-link";

export interface RefSystem {
  id: string;
  kind: SystemKind;
  label: string;
  /** how entries are keyed */
  grammar:
    | "sequential"
    | "bracketed"
    | "line-keyed"
    | "book-line"
    | "symbol"
    /** lettered keys: a, b, c … */
    | "alphabetic"
    /** Roman-numeral keys: i, ii, iii … */
    | "roman"
    | "author-date"
    /** entries carry no printed marker at all and are keyed by the phrase they quote */
    | "lemma-keyed"
    | "none";

  /** scope in which keys restart */
  keyScope: "document" | "chapter" | "book" | "section";
  /** structure node ids the entries live under */
  hosts: string[];
  typography: { size: number; indent: number; leading: number; altFontLemma: boolean };
  entryCount: number;
  evidence: string[];
  confidence: number;
  samples: { key: string; text: string }[];
}

export type RefType =
  | "note"
  | "footnote"
  | "endnote"
  | "line-note"
  | "commentary"
  | "translator-note"
  | "author-note"
  | "editorial-note"
  | "textual-note"
  | "citation"
  | "cross-reference"
  | "structural-navigation"
  | "page-reference"
  | "bibliography"
  | "glossary"
  | "appendix"
  | "figure"
  | "table"
  | "equation"
  | "external"
  | "hyperlink";

/** Structural navigation can be de-emphasized by the reader without losing the edge. */
export const STRUCTURAL_REF_TYPES: RefType[] = ["structural-navigation", "page-reference"];

/** How the parser came to know the reference exists. */
export type RefProvenance = "explicit-link" | "inferred";

export interface RefCandidate {
  /** block id of a possible destination */
  to: string;
  key: string;
  system: string;
  score: number;
  why: string;
}

export interface RefEdge {
  id: string;
  type: RefType;
  /** namespace the identifier was resolved in — a system id, or null */
  system: string | null;
  /** block id where the reference occurs (same as marker.blockId) */
  from: string;
  /** character offset of the anchor inside the block text (same as marker.start) */
  at: number;
  label: string;
  /** block id it resolves to, null when unresolved */
  to: string | null;
  /** structure node it resolves to, for structural references */
  toSection: string | null;
  method: "link" | "marker" | "line-key" | "lemma-match" | "page-map" | "annotation" | "heuristic" | "unresolved";
  confidence: number;
  note?: string;

  // --- semantic anchoring (phase 2.5) ---------------------------------------
  /** the identifier as it functions in its namespace ("326", "12", "*") */
  key: string;
  /** exact inline span of the marker */
  marker: TextRange;
  /** the complete sentence / semantic unit containing the marker — never truncated */
  sentence: TextRange;
  /** the complete paragraph (or verse line unit) containing the sentence */
  paragraph: TextRange;
  /** destination node id; mirrors `to` but is the name the popup layer consumes */
  destinationNodeId: string | null;
  /** why the parser believes this reference exists and resolves where it does */
  evidence: string[];
  /** kept when more than one destination was plausible */
  candidates?: RefCandidate[];
  /** true when the parser refused to pick between candidates */
  ambiguous?: boolean;

  // --- exact-range contract (phase 3.5) -------------------------------------
  /** the referenced expression exactly as it reads in the normalized document */
  sourceText: string;
  /** where inside the destination node the reference lands, when narrower than the node */
  targetLocation: { start: number; end: number } | null;
  /** explicit PDF link annotation vs. a reference the parser inferred */
  provenance: RefProvenance;
  /** reconciliation verdict: how strongly the text functions as a reference, and how sure the destination is */
  recognition?: { score: number; destinationConfidence: number; signals: string[] };
  /**
   * The file's own link annotation this edge came from, kept verbatim: source
   * page and rectangle, the exact character range of the page text it covered,
   * and the destination the file names. Present only for explicit links.
   */
  link?: {
    /** annotation identity reported by the extraction engine, when it has one */
    id?: string;
    /** page the annotation was printed on */
    page: number;
    rect: { x: number; y: number; w: number; h: number };
    /** exact character range of the page's own text the annotation covered */
    sourceCharRange: { start: number; end: number } | null;
    /** exact character range inside the source node the edge is anchored on */
    sourceRange: { start: number; end: number };
    destPage: number | null;
    destY: number | null;
    url: string | null;
  };
}


export interface DocumentModel {
  id: string;
  title: string;
  author: string | null;
  pageCount: number;
  structure: StructureNode[];
  blocks: Block[];
  systems: RefSystem[];
  refs: RefEdge[];
  diagnostics: {
    bodySize: number;
    bodyIndent: number;
    droppedFurniture: number;
    verseSections: number;
    unresolved: { label: string; from: string; reason: string }[];
    counts: Record<string, number>;
    /** PDF page -> printed page number, used to resolve "p. 6" */
    pageMap: import("./layout").PageMapEntry[];
    /** tokens taken out of the reading text, with the reason — nothing is discarded silently */
    removedTokens: import("./layout").RemovedToken[];
    /** fused words the normalizer split apart on the document's own evidence */
    repairedTokens: string[];
    /** embedded semantic regions recovered (block quotes, letters, lists) */
    embedded: { type: string; count: number }[];
    /** stage-by-stage report of the generic import pipeline */
    readiness: import("./stages").Readiness;
    stages: import("./stages").StageReport[];
    issues: import("./stages").Issue[];
    /** every reference candidate considered, with the reconciliation decision */
    recognition?: import("./reconcile").RecognitionRecord[];
    /** reference systems discovered before matching */
    referenceSystems?: import("./discover").SystemProfile[];
  };
}
