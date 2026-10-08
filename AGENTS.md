<!-- LOVABLE:BEGIN -->
> [!IMPORTANT]
> This project is connected to [Lovable](https://lovable.dev). Avoid rewriting
> published git history — force pushing, or rebasing/amending/squashing commits
> that are already pushed — as it rewrites history on Lovable's side and the
> user will likely lose their project history.
>
> Commits you push to the connected branch sync back to Lovable and show up in
> the editor, so keep the branch in a working state.
<!-- LOVABLE:END -->

- Note markers are classed and keyed in `src/lib/reader/markers.ts` (numeric, symbol, lettered, Roman); a token becomes a reference only with evidence (superscript/bracket typography, or a note system printing that key), and footnotes printed in the running text are found by pairing in `footnotes.ts` — why: markers must never be assumed numeric, and a bare symbol proves nothing.
- All PDF reading (pdf.js classification, Tesseract OCR, PDFium extraction, glyph OCR) runs in the browser ingest worker (`src/lib/ingest/`); the server only analyses the JSON it stores (`scan.json`, `ocr/p*.json`, `raw.json`) — why: the hosted server refuses to compile WebAssembly, and `src/lib/server-engines.test.ts` fails if any engine becomes reachable from server code or `public/engines/` drifts from the installed packages.
- Reference detectors in `references.ts` / `internal-refs.ts` only propose candidates with recognition signals; `reconcile.ts` alone decides recognition (combined signal score), validates destinations per system, merges or separates overlapping candidates and logs every decision, after `discover.ts` takes a document-wide census of reference systems — why: detection and resolution are separate problems, and reference-like vocabulary or one regex must never be enough to create a reference.
