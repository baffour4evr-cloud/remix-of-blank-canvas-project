import { CHUNK_PAGES, chunkRange, type ChunkArtifact, type ModelArtifact } from "./reader/artifacts";
import { layoutPages } from "./reader/layout";
import { analyze } from "./reader/pipeline";
import type { RawDoc, RawPage } from "./reader/types";

export interface BuiltImport {
  model: ModelArtifact;
  chunks: ChunkArtifact[];
}

export interface BuildOptions {
  /** used when the file carries no embedded title (scans never do) */
  title?: string;
  /** pages recovered by OCR, keyed by page number; they replace the empty native pages */
  ocrPages?: RawPage[];
}

/**
 * Analysis: extracted raw document -> persistable artifacts. Server only.
 * Pure JavaScript over stored JSON — the PDF itself was read in the browser
 * (src/lib/ingest), because no engine may start on the server.
 */
export async function buildImport(raw: RawDoc, id: string, opts: BuildOptions = {}): Promise<BuiltImport> {

  // Merge the OCR path into the same raw document. Everything downstream is
  // blind to which path a page came from.
  if (opts.ocrPages?.length) {
    // OCR line heights wobble page to page, which would read downstream as a
    // page full of slightly different font sizes (and therefore headings).
    // Snap every size close to the document's dominant one onto that value.
    const freq = new Map<number, number>();
    for (const p of opts.ocrPages) for (const it of p.items) freq.set(it.s, (freq.get(it.s) ?? 0) + 1);
    let body = 0;
    let bodyN = 0;
    for (const [size, n] of freq) if (n > bodyN) ((body = size), (bodyN = n));
    if (body > 0) {
      for (const p of opts.ocrPages) {
        for (const it of p.items) if (Math.abs(it.s - body) <= body * 0.16) it.s = body;
      }
    }

    const byPage = new Map(opts.ocrPages.map((p) => [p.page, p]));
    raw.pages = raw.pages.map((p) => {
      const ocr = byPage.get(p.page);
      if (!ocr || ocr.items.length === 0) return p;
      return { ...ocr, links: p.links };
    });
  }

  const laid = layoutPages(raw);
  if (opts.title && !raw.meta.title) raw.meta = { ...raw.meta, title: opts.title };
  const doc = analyze(raw, id);

  const methodOf = new Map(raw.pages.map((p) => [p.page, p.method ?? (p.items.length ? "native" : "empty")]));
  const confOf = new Map(raw.pages.filter((p) => p.ocr).map((p) => [p.page, p.ocr!.meanConfidence]));

  const { blocks, ...rest } = doc;
  const blockPage: Record<string, number> = {};
  const blockOrder: Record<string, number> = {};
  blocks.forEach((b, i) => {
    blockPage[b.id] = b.page;
    blockOrder[b.id] = i;
    if (b.prov) {
      const m = methodOf.get(b.page);
      if (m) b.prov.method = m;
      const c = confOf.get(b.page);
      if (c != null) b.prov.conf = c;
    }
  });

  const chunkCount = Math.max(1, Math.ceil(raw.pageCount / CHUNK_PAGES));
  const linksByPage = new Map(raw.pages.map((p) => [p.page, p.links]));
  const chunks: ChunkArtifact[] = [];
  for (let i = 0; i < chunkCount; i++) {
    const { from, to } = chunkRange(i, raw.pageCount);
    chunks.push({
      index: i,
      from,
      to,
      pages: laid.pages
        .filter((p) => p.page >= from && p.page <= to)
        .map((p) => ({
          page: p.page,
          width: p.width,
          height: p.height,
          lines: p.lines,
          links: linksByPage.get(p.page) ?? [],
          method: methodOf.get(p.page) ?? "empty",
          ...(confOf.has(p.page) ? { ocrConfidence: confOf.get(p.page)! } : {}),
        })),
      blocks: blocks.filter((b) => b.page >= from && b.page <= to),
    });
  }

  return {
    model: { ...rest, chunkCount, chunkPages: CHUNK_PAGES, blockPage, blockOrder },
    chunks,
  };
}
