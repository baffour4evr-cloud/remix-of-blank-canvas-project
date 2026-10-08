// Browser side of an import: everything that needs to open the PDF.
//
// The page downloads the file, hands it to the ingest worker, and stores each
// result in the document's folder the moment it arrives — classification, every
// OCR page, and the extracted text layer. The server's analysis step only ever
// reads those stored results. Resumable: work already stored is never redone.

import { supabase } from "@/integrations/supabase/client";
import type { OcrPageArtifact, ScanReport } from "../ocr/types";
import { RAW_ARTIFACT, SCAN_ARTIFACT, type IngestEvent, type IngestRequest } from "./protocol";

const BUCKET = "library";
const dir = (id: string) => `docs/${id}`;

export interface ReadProgress {
  status: "ocr" | "extracting";
  progress: number;
  label: string;
  page_count?: number;
  summary?: Record<string, unknown>;
}

async function getJson<T>(path: string): Promise<T | null> {
  const res = await supabase.storage.from(BUCKET).download(path);
  if (res.error || !res.data) return null;
  return JSON.parse(await res.data.text()) as T;
}

let inFlight = 0;
const waiters: Array<() => void> = [];

async function putJson(path: string, body: unknown) {
  // At most 4 uploads at once, 3 attempts each: a 600-page book queues hundreds of saves.
  while (inFlight >= 4) await new Promise<void>((r) => waiters.push(r));
  inFlight++;
  try {
    const blob = new Blob([JSON.stringify(body)], { type: "application/json" });
    let message = "";
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await supabase.storage.from(BUCKET).upload(path, blob, { upsert: true, contentType: "application/json" });
      if (!res.error) return;
      message = res.error.message;
      await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
    }
    throw new Error(`could not save ${path.split("/").pop()}: ${message}`);
  } finally {
    inFlight--;
    waiters.shift()?.();
  }
}

async function listNames(path: string): Promise<string[]> {
  const out: string[] = [];
  for (let offset = 0; ; offset += 1000) {
    const { data } = await supabase.storage.from(BUCKET).list(path, { limit: 1000, offset });
    if (!data?.length) break;
    out.push(...data.map((f) => f.name));
    if (data.length < 1000) break;
  }
  return out;
}

/**
 * Bring a document's stored reading results up to date. Resolves once
 * everything the server's analysis needs is in storage.
 */
export async function readInBrowser(
  doc: { id: string; sourcePath: string; title?: string },
  opts: { retryFailed?: boolean; onProgress: (p: ReadProgress) => void | Promise<void> },
): Promise<void> {
  const { id } = doc;
  const scan = await getJson<ScanReport>(`${dir(id)}/${SCAN_ARTIFACT}`);
  const done = new Set(
    (await listNames(`${dir(id)}/ocr`))
      .map((n) => /^p(\d+)\.json$/.exec(n))
      .filter((m): m is RegExpExecArray => !!m)
      .map((m) => Number(m[1])),
  );
  if (opts.retryFailed) {
    // Explicit retry of pages whose stored OCR failed or came back empty.
    for (const n of [...done]) {
      const art = await getJson<OcrPageArtifact>(`${dir(id)}/ocr/p${n}.json`);
      if (art?.hasImage === false && !art.error) continue; // proven blank
      if (!art || art.error || art.words.length === 0) done.delete(n);
    }
  }
  const needRaw = !(await listNames(dir(id))).includes(RAW_ARTIFACT);
  const pendingOcr = scan ? scan.ocrPages.filter((p) => !done.has(p)).length : 1;
  if (scan && !pendingOcr && !needRaw) return;

  const dl = await supabase.storage.from(BUCKET).download(doc.sourcePath);
  if (dl.error || !dl.data) throw new Error(`The PDF for this import is missing from storage (${doc.sourcePath}).`);
  const bytes = await dl.data.arrayBuffer();

  const worker = new Worker(new URL("./ingest.worker.ts", import.meta.url), { type: "module" });
  const saves: Promise<unknown>[] = [];
  let ocrTotal = scan?.ocrPages.length ?? 0;
  try {
    await new Promise<void>((resolve, reject) => {
      worker.onerror = (e) => reject(new Error(e.message || "the reading engine stopped unexpectedly"));
      worker.onmessage = (msg: MessageEvent<IngestEvent>) => {
        const e = msg.data;
        switch (e.type) {
          case "scan":
            ocrTotal = e.scan.ocrPages.length;
            saves.push(
              putJson(`${dir(id)}/${SCAN_ARTIFACT}`, e.scan).then(() =>
                opts.onProgress({
                  status: e.scan.ocrPages.length ? "ocr" : "extracting",
                  progress: 5,
                  label: "classified",
                  page_count: e.scan.pageCount,
                  summary: { kind: e.scan.kind, ocrPages: e.scan.ocrPages.length },
                }),
              ),
            );
            break;
          case "ocr":
            saves.push(putJson(`${dir(id)}/ocr/p${e.art.page}.json`, e.art));
            break;
          case "raw":
            saves.push(
              putJson(`${dir(id)}/${RAW_ARTIFACT}`, {
                raw: e.raw,
                recovered: e.recovered,
                unresolved: e.unresolved,
              }),
            );
            break;
          case "progress": {
            const label =
              e.stage === "classify"
                ? `checking page ${e.done}/${e.total}`
                : e.stage === "ocr"
                  ? `OCR ${e.done}/${e.total} pages`
                  : `reading page ${e.done}/${e.total}`;
            const progress =
              e.stage === "classify"
                ? Math.round((e.done / e.total) * 5)
                : e.stage === "ocr"
                  ? 5 + Math.round((e.done / Math.max(1, ocrTotal)) * 75)
                  : 80 + Math.round((e.done / e.total) * 8);
            // Status writes are throttled to whole-percent changes by the caller.
            void opts.onProgress({ status: e.stage === "ocr" ? "ocr" : "extracting", progress, label });
            break;
          }
          case "done":
            resolve();
            break;
          case "error":
            reject(new Error(e.message));
            break;
        }
      };
      const req: IngestRequest = {
        bytes,
        scan,
        skipOcr: [...done],
        needRaw,
        ...(doc.title ? { title: doc.title } : {}),
      };
      worker.postMessage(req, [bytes]);
    });
    await Promise.all(saves);
  } finally {
    worker.terminate();
  }
}
