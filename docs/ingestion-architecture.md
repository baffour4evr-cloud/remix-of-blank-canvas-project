# Document ingestion architecture — audit and recommendation

Investigation only. No pipeline code was changed for this document.
Baseline at time of writing: 136 tests pass (10 files), typecheck clean, build OK.

---

## 1. Current architecture

```text
PDF bytes
  │  unpdf (bundled pdf.js)                     src/lib/pdf-extract.server.ts:95
  ├─ page.getTextContent()  -> TextItem runs    :136
  ├─ page.getOperatorList() -> glyph stream     :22-54   (only on "suspect" pages :178)
  ├─ alignCodes()  per-char {code,fontChar}     :64-84
  ├─ page.getAnnotations() -> links + covered text :196-241
  └─ getMetadata/getOutline                     :101-128
        v  RawItem{x,y,w,s,f,t,t0,o,h,fam}
FONT/ENCODING REPAIR  recoverFonts()            src/lib/reader/font-recovery.ts:274
  per font identity `${fontName}|${family}`; candidates font-char, char-code,
  constant offset, glyph-alphabet; scored vs document vocabulary; heuristics
  gated at confidence >= 0.55                   :272,340-399
  writes item.t, item.repair, item.map, item.sc  pdf-extract.server.ts:259-281
        v
UNICODE NORMALIZATION  normalizeText()          src/lib/reader/unicode.ts:24-35
  NFC, ligature expansion, strip ZW*/soft hyphen/BOM, exotic spaces -> " "
        v
LAYOUT RECONSTRUCTION  buildLines()             src/lib/reader/lines.ts:84-202
  baseline clustering (1.6pt), superscript folding :106-148,
  SPACE INSERTION gap > 0.14 * fontSize          :158-164,
  fixGluedPunctuation across run edges           :10-17 + unicode.ts:53-65,
  whitespace collapse                            :180-184,
  em inferred from "font != dominant font"       :171
  layoutPages() doc statistics + furniture removal  layout.ts:54-186
        v
SEMANTICS BEGIN  buildContent()                 src/lib/reader/content.ts:394
  headings, verse zoning, paragraph joining (gap/indent) :527-570,
  line joiner drops/keeps hyphen                  :729-750,
  repairGluedTokens() second text mutation        :912-984
  detectApparatus / buildReferences               pipeline.ts:20-113
  superscript digit runs -> reference markers      references.ts:284-352
        v  DocumentModel
PERSISTENCE  import.server.ts:21 -> model.json + chunk-N.json (25 pages)
  OCR fallback merged into RawDoc                 import.server.ts:26-47
        v
READER DOM  toReaderBlock()                     src/lib/reader/inline.ts:170-207
  slices authoritative block.text by run + ref ranges; BlockView/RichText apply
  CSS classes only — no text mutation in the DOM layer.
```

Text can change in exactly six places: `recoverFonts`, `normalizeText`,
`buildLines` (space insertion + collapse), `fixGluedPunctuation`, the line
joiner in `content.ts`, and `repairGluedTokens`. Only the first two claim to be
about "what the file encoded"; the other four are reconstruction decisions taken
from geometry and document statistics.

Dead weight: `encoding.ts:recoverEncoding` and `glyph-repair.ts:repairGlyphs` are
an earlier implementation of the same repair, still tested but no longer called.

## 2. Older vs current extraction

There is no separate "older parser" in history — the app was created whole in one
commit (`18de1fa`) and extraction has always been unpdf/pdf.js `getTextContent`.
What changed is the *repair discipline*:

| | original (`18de1fa`) | current |
|---|---|---|
| glyph stream read when | `UNDECODABLE.test(t)` only | also when text merely looks foreign (`hasForeignScript`) |
| repair engine | `repairGlyphs` — alphabet run for fonts with **no** Unicode map | `recoverFonts` — 5 candidate mapping families incl. arbitrary constant offsets |
| may rewrite text that decoded cleanly | no | yes (any font judged "mostly foreign", or any font with one undecodable char) |
| confidence gate | n/a (only applied where nothing was decodable) | statistical score, bar 0.55 |
| evidence scope | document-wide vocabulary | per font identity (an improvement) |

So the older path parsed some documents more reliably for a structural reason,
not a clever one: **it only ever invented characters where pdf.js had produced
none.** The current system is allowed to overwrite text that was already correct,
and a statistical score computed over a nine-character heading is weak evidence.
Per-font isolation and provenance records in the current system are genuine
improvements and should be kept.

## 3. Readest / Foliate JS comparison

- **foliate-js** is organised as three interfaces — book (parsers), renderer
  (`paginator.js` reflowable, `fixed-layout.js` pre-paginated) and auxiliary
  modules (`overlayer.js`, `search.js`, `text-walker.js`, `epubcfi.js`,
  `footnotes.js`, `tts.js`).
- Its **PDF module does not reconstruct a document at all.** It sets
  `rendition.layout = 'pre-paginated'`, renders each page to `<canvas>` via
  `page.render()`, and overlays PDF.js's own `TextLayer` and `AnnotationLayer`.
  Everything about PDF text is delegated to PDF.js; foliate-js adds only the
  section wrapper, caching, and selection glitch fixes.
- **Readest** vendors foliate-js as its book engine and `pdfjs-dist` for PDF, and
  layers domain services (annotations, navigation, transformers, TTS, footnote
  popups, search) on the engine's DOM/CFI abstractions. Its PDF text quality is
  therefore bounded by PDF.js text-layer segmentation
  ([pdf.js#18201](https://github.com/mozilla/pdf.js/issues/18201)).

Conclusion: neither project solves our problem, because neither reflows PDF text.
What they do offer is the **interface shape** worth copying: a document/section
interface, a text walker producing stable character-offset anchors, an overlay
layer for annotations, and footnote/search as modules over that — exactly the
"semantics consume the reconstruction" separation we want.

Fidelity note on extraction libraries: pdf.js (and therefore unpdf) deliberately
exposes only per-run `TextItem` geometry — per-character boxes were rejected
upstream ([pdf.js#18239](https://github.com/mozilla/pdf.js/pull/18239)). MuPDF's
`StructuredText` (`mupdf.js`, WASM, Node/Bun/Workers) and PDFium's `FPDFText_*`
bindings do expose per-character bbox + font.

## 4. Root causes of the observed failures

| failure | responsible stage | cause |
|---|---|---|
| `JANE AUSTEN` -> Sinhala | `font-recovery.ts:327` | a font is only treated as broken when ≥80% of its own characters are foreign; a display font mixing digits/punctuation with shifted letters falls under the bar and is left as-is. Vocabulary evidence is never consulted for partially-foreign fonts. |
| `CHAPTER 1` -> `hm fuyjw n` | `font-recovery.ts:346-363, 393-399` | constant-offset candidates are enumerated blind and scored on that font's own few characters; with no minimum sample size an offset five letters off clears the 0.55 bar. Heuristic applied where no authoritative mapping was even available. |
| `VOLUME I` loses small caps | `pdf-extract.server.ts:274` + `lines.ts:171` | `sc` is set *only* when the font had no Unicode map; a real small-caps font with a valid `/ToUnicode` gets no flag, and `em: it.f !== roman` then renders it italic instead. Typography is being inferred from mapping failure rather than from font identity. |
| `ḯ` | presentation only | model and persistence were correct; the serif face misdrew stacked diacritics (fixed in `styles.css`). |
| wrong word spacing | `lines.ts:158-164` | spaces synthesised from `x - prevEnd > 0.14 * size`, ignoring advance widths, kerning and `hasEOL`; then `fixGluedPunctuation` and `repairGluedTokens` patch the damage with statistics. |
| markers attach to neighbouring words | `lines.ts:106-148` -> `references.ts:284-352` -> `inline.ts` range mapping | a raised cluster is folded into a host line and loses its own position; the marker's character offset is then re-derived, so a range can land against the adjoining word. |
| ordinary numbers become reference metadata | `lines.ts` superscript inference + `references.ts:292-300` | "small and raised" is treated as semantic superscript; any 1–3 digit superscript run becomes a marker candidate. Visual typography is doing semantic work. |

The common boundary error: **reconstruction decisions (spacing, superscript,
emphasis) are made from pixels and then consumed as semantic facts, while
character repair is allowed to edit text that was never broken.**

## 5. Recommended foundation — hybrid (option E)

```text
RAW DOCUMENT FIDELITY   -> evidence only, zero interpretation
DOCUMENT RECONSTRUCTION -> words, lines, paragraphs, typography
SEMANTIC ENRICHMENT     -> structure, apparatus, references, notes
READER FEATURES         -> render, annotate, search, TTS
```

1. **Keep pdf.js/unpdf** for document-level facts it does well: metadata,
   outline, link annotations, destinations, page geometry, and page rasters.
2. **Add a per-character evidence layer** (`mupdf.js` structured text preferred;
   PDFium wasm as alternative) so words and spaces come from real character
   boxes and advance widths instead of a 14% gap guess. Behind one interface, with
   the pdf.js text layer as a fallback producer.
3. **Restore the older repair discipline, keep the new bookkeeping**: repair only
   where the parser produced nothing usable, or where authoritative font tables
   contradict it; per-font identity, provenance and confidence records retained;
   no blind offset search, minimum per-font sample size, uncertain rather than
   guessed.
4. **Typography from font identity, not from mapping failure**: small caps, bold
   and italic read from font descriptors/flags and names, carried as metadata.
5. **Semantics strictly downstream**, consuming reconstructed words/lines with
   stable character offsets (foliate-style anchors), never editing text.
6. **For EPUB and other formats, adopt foliate-js** rather than growing our own
   engine; keep our reconstruction layer for PDF only.

## 6. Proposed extraction contract

```ts
// The extraction layer produces evidence. It interprets nothing.
export interface SourceChar {
  ch: string;              // unicode as the mapping source gave it
  code: number | null;     // content-stream character code
  gid: number | null;      // glyph id, when exposed
  bbox: Box;               // per-character box in PDF user space
  origin: { x: number; y: number };  // baseline origin
  advance: number;         // advance width, for space reconstruction
  font: FontRef;
  source: "to-unicode" | "font-cmap" | "char-code" | "ocr" | "repaired";
  confidence?: number;     // OCR / repair only
}

export interface FontRef {
  id: string;              // stable per embedded font *and* subset
  psName: string; family: string; subset: string | null;
  subtype: string;         // Type1 | TrueType | Type0 | ...
  size: number;
  flags: { serif: boolean; italic: boolean; bold: boolean; smallCaps: boolean; symbolic: boolean };
  hasToUnicode: boolean; hasEmbeddedProgram: boolean;
}

export interface SourceRun { chars: SourceChar[]; font: FontRef; order: number; bbox: Box; hasEOL: boolean; }

export interface SourcePage {
  page: number; width: number; height: number; rotation: number;
  runs: SourceRun[];
  links: SourceLink[];     // rect, dest page + y, url, covered char range
  images: SourceImage[];   // bbox, kind, so figures/captions are possible later
  method: "native" | "ocr"; ocr?: { meanConfidence: number };
}

export interface SourceDoc { pageCount: number; meta: DocMeta; outline: OutlineEntry[]; structTree?: StructNode[]; pages: SourcePage[]; }

export interface RepairRecord {         // unchanged in spirit, kept per char range
  kind: string; authoritative: boolean; confidence: number;
  evidence: string; raw: string; recovered: string; font: string;
}
```

`SourceDoc` is immutable and persisted alongside the model, so any later
question ("where did this character come from?") is answerable without re-parsing.

## 7. Files that should change

| file | change |
|---|---|
| `src/lib/pdf-extract.server.ts` | becomes a *producer* of `SourceDoc`; drops repair application and normalization |
| new `src/lib/source/` | `types.ts` (contract), `pdfjs.ts` (current producer), `mupdf.ts` (per-char producer), `producer.ts` (selection) |
| `src/lib/reader/font-recovery.ts` | authoritative-first only; sample-size floor; no blind offset enumeration; operates on `SourceChar` |
| `src/lib/reader/encoding.ts`, `glyph-repair.ts` | delete (superseded); keep their tests as cases against the new module |
| new `src/lib/reader/words.ts` | words/spaces from advances and char boxes; removes the 0.14 gap rule |
| `src/lib/reader/lines.ts` | consumes words; typography flags read from `FontRef`, not inferred; superscript keeps its own position |
| `src/lib/reader/unicode.ts` | keep NFC/ligature/invisible-char normalization; move `fixGluedPunctuation` out of the fidelity path |
| `src/lib/reader/content.ts` | keep paragraph reconstruction; remove `repairGluedTokens` once spacing is sound |
| `src/lib/reader/references.ts` | superscript is a hint, not a marker test; require apparatus-system support |
| `src/lib/reader/artifacts.ts`, `import.server.ts`, `import-run.server.ts` | persist `source-*.json` beside `model.json`; version the artifacts |
| `src/lib/ocr/to-raw.ts` | emits `SourcePage` with per-word confidence, same contract as native |
| reader components | unchanged (they already only slice authoritative text) |

## 8. Ordered implementation plan

1. Land the contract: `src/lib/source/types.ts` plus a pdf.js producer that fills
   it from today's evidence. No behaviour change; snapshot tests on fixtures.
2. Add the per-character producer (`mupdf.js`) behind the same interface, with a
   runtime check that it works in the Worker build; choose producer per document
   and record which one ran.
3. Rebuild word/space reconstruction from advances and char boxes; delete the
   0.14 gap rule and `repairGluedTokens`; regression-test spacing.
4. Tighten repair: authoritative-first, per-font sample floor, no blind offsets,
   uncertain preserved. Re-run the corruption fixtures.
5. Read typography (small caps, italic, bold) from `FontRef`; remove
   `em: font != dominant` and the `sc`-from-undecodable rule.
6. Decouple superscript: keep it as typography; require apparatus evidence before
   a number becomes a reference marker.
7. Persist and version artifacts, including `SourceDoc`; add a re-import path.
8. Delete `encoding.ts`/`glyph-repair.ts`; fold their cases into the new tests.
9. Only then continue reference intelligence, annotations and TTS on top.

Steps 1–3 address spacing and fidelity, 4–5 the corruption class, 6 the false
reference metadata. Each step is independently shippable.

---

## Decision and implementation (ingestion v2)

**Engine of record: PDFium** (`@embedpdf/pdfium`, BSD/Apache core, MIT wrapper).
Evaluated against pdf.js (run-level text only, and it *fabricates* characters for
fonts with no usable mapping) and mupdf.js (excellent, but AGPL-3.0 — unusable for
a commercial product — plus bundler friction in Workers). PDFium exposes
per-character Unicode, box, origin, font identity, descriptor flags and weight,
plus links, outline, metadata and a rasterizer for the OCR fallback. Both PDFium
and MuPDF agree that the display/small-caps fonts in our regression book supply
*no* mapping (U+0000 / U+FFFD) — so "no mapping available" is ground truth, and
guessing an offset was always wrong.

Pipeline:

```text
PDF bytes
  -> pdfium.server.ts     per-character evidence, observation only
  -> reconstruct.ts       engine's own words/lines; typography from font flags;
                          spans split where mapping availability changes
  -> glyph-ocr.server.ts  undecodable spans only: rasterize that span's own box
                          and read the rendered glyphs (confidence gated)
  -> RawDoc -> layout -> analyze -> references/annotations -> reader
```

Rules the architecture now enforces structurally rather than by heuristic:

- a character the file decoded is never rewritten — recovery can only touch a
  span that is *entirely* undecodable, because spans are split at the mapping
  boundary before recovery runs;
- appearance is never Unicode evidence: no gap-width spacing, no offset guessing,
  no statistics across fonts;
- typography (italic, bold, small caps, mono) is read from the font's own flags
  and stored beside the text, never applied to it;
- OCR is an alternative *extraction source*, not a repair pass, and records
  confidence and provenance;
- removed entirely: `pdf-extract.server.ts`, `reader/font-recovery.ts`,
  `reader/encoding.ts`, `reader/glyph-repair.ts` and the pdf.js comparison
  producer — the classes of bug they caused cannot recur.
