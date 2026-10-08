// Server side of an import: analysis only.
//
//   browser (src/lib/ingest):  classify -> OCR pages -> text layer  -> storage
//   server  (this module):     stored results -> analysis -> artifacts
//
// The hosted server refuses to compile WebAssembly, so it never opens the PDF:
// every engine (PDFium, Tesseract, pdf.js) runs in the reader's browser, which
// stores each result as it is produced. This step reads those results only.

import { buildImport } from "./import.server";
import { RAW_ARTIFACT, SCAN_ARTIFACT } from "./ingest/protocol";
import { ocrPageToRaw } from "./ocr/to-raw";
import type { OcrPageArtifact, ScanReport } from "./ocr/types";
import type { RawDoc } from "./reader/types";

const BUCKET = "library";

async function db() {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return supabaseAdmin;
}

const dir = (id: string) => `docs/${id}`;

async function put(id: string, name: string, body: unknown) {
  const client = await db();
  const res = await client.storage
    .from(BUCKET)
    .upload(`${dir(id)}/${name}`, new Blob([JSON.stringify(body)], { type: "application/json" }), {
      upsert: true,
      contentType: "application/json",
    });
  if (res.error) throw new Error(res.error.message);
}

async function get<T>(id: string, name: string): Promise<T | null> {
  const client = await db();
  const res = await client.storage.from(BUCKET).download(`${dir(id)}/${name}`);
  if (res.error || !res.data) return null;
  return JSON.parse(await res.data.text()) as T;
}

export interface StepResult {
  id: string;
  phase: "analyze" | "done";
  done: boolean;
  progress: number;
  ocrDone: number;
  ocrTotal: number;
  /** pages whose OCR was already on disk when this step started */
  ocrReused?: number;
  kind?: string;
  summary?: Record<string, number | string | null>;
}

async function setStatus(id: string, patch: Record<string, unknown>) {
  const client = await db();
  await client.from("documents").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", id);
}

/**
 * Advance one import by one bounded step. Safe to call repeatedly; each call
 * picks up exactly where the previous one stopped.
 */
export async function importStep(id: string): Promise<StepResult> {
  const client = await db();
  const { data: row } = await client
    .from("documents")
    .select("id,title,filename,summary")
    .eq("id", id)
    .single();
  if (!row) throw new Error("unknown document");
  const summary = (row.summary ?? {}) as Record<string, unknown>;
  const path = String(summary["sourcePath"] ?? "");
  if (!path) throw new Error("document has no source file");

  const scan = await get<ScanReport>(id, SCAN_ARTIFACT);
  const extracted = await get<{ raw: RawDoc; recovered: number; unresolved: number }>(id, RAW_ARTIFACT);
  if (!scan || !extracted) {
    throw new Error("This book has not been fully read yet. Press Resume to finish reading it.");
  }
  // Reports written before per-page kinds existed still carry the decision that
  // produced them, so the kind is recovered instead of re-classifying the file.
  for (const p of scan.pages) {
    if (p.kind) continue;
    p.kind = p.method === "native" ? "native" : p.recovered ? "poor_native" : "scanned";
  }
  const reused = scan.ocrPages.length;

  // --- 3. analysis over the merged raw document -----------------------------
  await setStatus(id, { status: "extracting", progress: 88 });
  // Per-page ingestion facts, kept for diagnostics, and the final page
  // classification: a page the classifier could only call a scan candidate is
  // now known to have carried an image or not.
  const ocrPages: ReturnType<typeof ocrPageToRaw>[] = [];
  const classOf = new Map(scan.pages.map((p) => [p.page, p]));
  let ocrFailedPages = 0;
  let ocrEmptyPages = 0;
  let blankPages = 0;
  let confSum = 0;
  for (const n of scan.ocrPages) {
    const art = await get<OcrPageArtifact>(id, `ocr/p${n}.json`);
    if (!art) continue;
    ocrPages.push(ocrPageToRaw(art));
    const pc = classOf.get(n);
    if (art.error) ocrFailedPages++;
    else if (art.words.length === 0) ocrEmptyPages++;
    if (art.hasImage === false) {
      blankPages++;
      if (pc && pc.kind === "scanned") {
        pc.kind = "empty";
        pc.method = "empty";
        pc.reason = "no text layer and no image on the page — blank";
      }
    } else if (pc) {
      pc.images = Math.max(pc.images, 1);
      if (art.imgWidth && art.pdfWidth) pc.imageCoverage = 1;
    }
    confSum += art.meanConfidence;
  }
  // The refined classification is persisted, so re-opening shows what the
  // pages actually were, not what they looked like before OCR ran.
  scan.kind = (() => {
    const nat = scan.pages.filter((p) => p.kind === "native").length;
    const scanned = scan.pages.filter((p) => p.kind === "scanned" || p.kind === "poor_native").length;
    if (!nat && !scanned) return "empty";
    if (!scanned) return "native-text";
    return nat ? "mixed" : "scanned";
  })();
  await put(id, "scan.json", scan);
  const recoveredPages = scan.pages.filter((p) => p.recovered).length;

  const started = Date.now();
  const { model, chunks } = await buildImport(extracted.raw, id, { ocrPages, title: String(row.title ?? "") });
  await put(id, "model.json", model);
  for (const c of chunks) await put(id, `chunk-${c.index}.json`, c);

  const { readiness, issues, stages } = model.diagnostics;
  const extraction = stages.find((s) => s.id === "extraction");
  const finalSummary: Record<string, number | string | null> = {
    ...model.diagnostics.counts,
    systems: model.systems.length,
    refs: model.refs.length,
    unresolved: model.refs.filter((r) => !r.to && !r.toSection).length,
    verseSections: model.diagnostics.verseSections,
    droppedFurniture: model.diagnostics.droppedFurniture,
    readiness,
    issues: issues.length,
    failedStages: stages.filter((s) => s.status === "failed").length,
    kind: scan.kind,
    pdfPages: scan.pageCount,
    nativePages: scan.pages.filter((p) => p.kind === "native").length,
    poorNativePages: scan.pages.filter((p) => p.kind === "poor_native").length,
    scannedPages: scan.pages.filter((p) => p.kind === "scanned").length,
    emptyPages: scan.pages.filter((p) => p.kind === "empty").length,
    ocrPages: scan.ocrPages.length,
    recoveredPages,
    ocrFailedPages,
    ocrEmptyPages,
    blankPages,
    normalizedPages: model.pageCount,
    ocrReusedPages: reused,
    ocrRanThisPass: Math.max(0, scan.ocrPages.length - reused),
    ocrMeanConfidence:
      extraction?.metrics["ocrMeanConfidence"] ??
      (scan.ocrPages.length ? Math.round((confSum / scan.ocrPages.length) * 1000) / 1000 : 0),
    ms: Date.now() - started,
    sourcePath: path,
  };

  const blocking = issues.filter((i) => i.severity === "error");
  await setStatus(id, {
    status: readiness === "unreadable" ? "unreadable" : "ready",
    progress: 100,
    page_count: model.pageCount,
    title: model.title && model.title !== "Untitled" ? model.title : row.title,
    summary: finalSummary,
    error: blocking.length ? blocking.map((i) => `${i.code}: ${i.message}`).join(" · ") : null,
  });

  return {
    id,
    phase: "done",
    done: true,
    progress: 100,
    ocrDone: scan.ocrPages.length,
    ocrTotal: scan.ocrPages.length,
    ocrReused: reused,
    kind: scan.kind,
    summary: finalSummary,
  };
}
