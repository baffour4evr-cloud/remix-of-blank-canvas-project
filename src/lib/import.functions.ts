import { createServerFn } from "@tanstack/react-start";

import type { ChunkArtifact, ModelArtifact } from "./reader/artifacts";

const BUCKET = "library";

async function admin() {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return supabaseAdmin;
}

export interface DocumentRow {
  id: string;
  title: string;
  filename: string;
  page_count: number;
  status: string;
  progress: number;
  error: string | null;
  summary: Record<string, number | string | null>;
  created_at: string;
}

export const listDocuments = createServerFn({ method: "GET" }).handler(async () => {
  const db = await admin();
  const { data, error } = await db
    .from("documents")
    .select("id,title,filename,page_count,status,progress,error,summary,created_at")
    .order("created_at", { ascending: false });
  if (error) throw new Error(error.message);
  return (data ?? []) as unknown as DocumentRow[];
});

export const deleteDocument = createServerFn({ method: "POST" })
  .inputValidator((d: { id: string }) => d)
  .handler(async ({ data }) => {
    const db = await admin();
    for (const sub of ["", "/ocr"]) {
      for (let offset = 0; ; offset += 1000) {
        const { data: files } = await db.storage
          .from(BUCKET)
          .list(`docs/${data.id}${sub}`, { limit: 1000, offset });
        if (!files?.length) break;
        await db.storage.from(BUCKET).remove(files.map((f) => `docs/${data.id}${sub}/${f.name}`));
        if (files.length < 1000) break;
      }
    }
    await db.from("documents").delete().eq("id", data.id);
    return { ok: true };
  });

/**
 * Register a PDF that already sits in storage. The browser then reads it
 * (src/lib/ingest/run.ts) and `advanceImport` analyses what it stored.
 */
export const importDocument = createServerFn({ method: "POST" })
  .inputValidator((d: { storagePath: string; title?: string }) => d)
  .handler(async ({ data }) => {
    const db = await admin();
    const filename = data.storagePath.split("/").pop() ?? "document.pdf";
    const { data: row, error: insErr } = await db
      .from("documents")
      .insert({
        title: data.title ?? filename,
        filename,
        status: "extracting",
        progress: 0,
        summary: { sourcePath: data.storagePath },
      })
      .select("id")
      .single();
    if (insErr || !row) throw new Error(insErr?.message ?? "could not create document");
    return { id: row.id as string };
  });

/** Progress reported by the browser while it reads the PDF. */
export const reportImportProgress = createServerFn({ method: "POST" })
  .inputValidator(
    (d: {
      id: string;
      status?: "ocr" | "extracting" | "failed";
      progress?: number;
      page_count?: number;
      error?: string | null;
      summary?: Record<string, unknown>;
    }) => d,
  )
  .handler(async ({ data }) => {
    const db = await admin();
    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (data.status) patch["status"] = data.status;
    if (data.progress != null) patch["progress"] = Math.max(0, Math.min(99, Math.round(data.progress)));
    if (data.page_count != null) patch["page_count"] = data.page_count;
    if (data.error !== undefined) patch["error"] = data.error;
    if (data.summary) {
      const { data: row } = await db.from("documents").select("summary").eq("id", data.id).single();
      patch["summary"] = { ...((row?.summary as Record<string, unknown>) ?? {}), ...data.summary };
    }
    await db.from("documents").update(patch as never).eq("id", data.id);
    return { ok: true };
  });

/** Analyse what the browser stored for this document. No PDF is opened here. */
export const advanceImport = createServerFn({ method: "POST" })
  .inputValidator((d: { id: string }) => d)
  .handler(async ({ data }) => {
    const db = await admin();
    try {
      const { importStep } = await import("./import-run.server");
      return await importStep(data.id);
    } catch (e) {
      await db
        .from("documents")
        .update({ status: "failed", error: e instanceof Error ? e.message : String(e) })
        .eq("id", data.id);
      throw e;
    }
  });

export const getModel = createServerFn({ method: "GET" })
  .inputValidator((d: { id: string }) => d)
  .handler(async ({ data }) => {
    const db = await admin();
    const res = await db.storage.from(BUCKET).download(`docs/${data.id}/model.json`);
    // Document still importing (or import failed): no artifacts yet — not an error.
    if (res.error || !res.data) return null;
    return JSON.parse(await res.data.text()) as ModelArtifact;
  });

export const getChunk = createServerFn({ method: "GET" })
  .inputValidator((d: { id: string; index: number }) => d)
  .handler(async ({ data }) => {
    const db = await admin();
    const res = await db.storage.from(BUCKET).download(`docs/${data.id}/chunk-${data.index}.json`);
    if (res.error || !res.data) throw new Error("chunk not found");
    return JSON.parse(await res.data.text()) as ChunkArtifact;
  });

/** Signed URL to the original PDF, for the comparison panel. */
export const getSourceUrl = createServerFn({ method: "GET" })
  .inputValidator((d: { id: string }) => d)
  .handler(async ({ data }) => {
    const db = await admin();
    const { data: row } = await db.from("documents").select("summary").eq("id", data.id).single();
    const path = (row?.summary as Record<string, unknown> | null)?.["sourcePath"];
    if (typeof path !== "string") return { url: null as string | null };
    const signed = await db.storage.from(BUCKET).createSignedUrl(path, 60 * 60 * 6);
    return { url: signed.data?.signedUrl ?? null };
  });

/** One row of the flattened reference index used by the sidebar and search. */
export interface RefIndexEntry {
  id: string;
  type: string;
  system: string | null;
  systemLabel: string | null;
  key: string;
  label: string;
  from: string;
  to: string | null;
  sourcePage: number;
  destPage: number | null;
  sectionLabel: string;
  method: string;
  confidence: number;
  ambiguous: boolean;
  /** the complete source sentence, as normalized text */
  sourceSentence: string;
  /** the destination node's text (plus its continuation nodes), untruncated */
  destText: string;
}

/**
 * Flattened, cached index of every reference edge with its resolved source
 * sentence and destination text. Built once from the chunk artifacts and
 * persisted, so the sidebar and reference search never re-scan the document.
 */
export const getRefIndex = createServerFn({ method: "GET" })
  .inputValidator((d: { id: string }) => d)
  .handler(async ({ data }): Promise<RefIndexEntry[]> => {
    const db = await admin();
    const cached = await db.storage.from(BUCKET).download(`docs/${data.id}/refindex.json`);
    if (!cached.error && cached.data) return JSON.parse(await cached.data.text()) as RefIndexEntry[];

    const modelRes = await db.storage.from(BUCKET).download(`docs/${data.id}/model.json`);
    if (modelRes.error || !modelRes.data) return [];
    const model = JSON.parse(await modelRes.data.text()) as ModelArtifact;

    const blocks: ChunkArtifact["blocks"] = [];
    for (let i = 0; i < model.chunkCount; i++) {
      const res = await db.storage.from(BUCKET).download(`docs/${data.id}/chunk-${i}.json`);
      if (res.error || !res.data) continue;
      blocks.push(...(JSON.parse(await res.data.text()) as ChunkArtifact).blocks);
    }
    const at = new Map(blocks.map((b, i) => [b.id, i]));
    const sections = new Map(model.structure.map((s) => [s.id, s]));
    const systems = new Map(model.systems.map((s) => [s.id, s]));

    const destTextOf = (blockId: string): string => {
      const i = at.get(blockId);
      if (i == null) return "";
      const head = blocks[i]!;
      const parts = [head.text];
      for (let j = i + 1; j < blocks.length; j++) {
        const b = blocks[j]!;
        if (b.section !== head.section) break;
        if (b.type === "heading" || b.type === "entry" || b.key) break;
        if (head.type !== "entry" && head.type !== "paragraph") break;
        if (b.type !== "paragraph") break;
        parts.push(b.text);
      }
      return parts.join("\n\n");
    };

    const rows: RefIndexEntry[] = model.refs.map((r) => {
      const src = blocks[at.get(r.from) ?? -1];
      const sentence = src ? src.text.slice(r.sentence.start, r.sentence.end).trim() : "";
      const sys = r.system ? systems.get(r.system) : undefined;
      return {
        id: r.id,
        type: r.type,
        system: r.system,
        systemLabel: sys?.label ?? null,
        key: r.key,
        label: r.label,
        from: r.from,
        to: r.to,
        sourcePage: model.blockPage[r.from] ?? src?.page ?? 0,
        destPage: r.to ? model.blockPage[r.to] ?? null : null,
        sectionLabel: src ? sections.get(src.section)?.label ?? src.section : "",
        method: r.method,
        confidence: r.confidence,
        ambiguous: !!r.ambiguous,
        sourceSentence: sentence,
        destText: r.to ? destTextOf(r.to) : "",
      };
    });

    await db.storage
      .from(BUCKET)
      .upload(`docs/${data.id}/refindex.json`, new Blob([JSON.stringify(rows)], { type: "application/json" }), {
        upsert: true,
        contentType: "application/json",
      });
    return rows;
  });

export interface SearchHit {

  blockId: string;
  page: number;
  section: string;
  type: string;
  snippet: string;
}

/** Full-text search across the normalized document (not the PDF). */
export const searchDocument = createServerFn({ method: "GET" })
  .inputValidator((d: { id: string; q: string }) => d)
  .handler(async ({ data }): Promise<SearchHit[]> => {
    const q = data.q.trim().toLowerCase();
    if (q.length < 2) return [];
    const db = await admin();
    const model = JSON.parse(
      await (await db.storage.from(BUCKET).download(`docs/${data.id}/model.json`)).data!.text(),
    ) as ModelArtifact;
    const hits: SearchHit[] = [];
    for (let i = 0; i < model.chunkCount && hits.length < 200; i++) {
      const res = await db.storage.from(BUCKET).download(`docs/${data.id}/chunk-${i}.json`);
      if (res.error || !res.data) continue;
      const chunk = JSON.parse(await res.data.text()) as ChunkArtifact;
      for (const b of chunk.blocks) {
        const at = b.text.toLowerCase().indexOf(q);
        if (at < 0) continue;
        hits.push({
          blockId: b.id,
          page: b.page,
          section: b.section,
          type: b.type,
          snippet: b.text.slice(Math.max(0, at - 60), at + q.length + 80),
        });
        if (hits.length >= 200) break;
      }
    }
    return hits;
  });
