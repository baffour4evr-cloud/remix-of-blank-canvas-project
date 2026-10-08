import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useRef, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import {
  type DocumentRow,
  advanceImport,
  deleteDocument,
  importDocument,
  listDocuments,
  reportImportProgress,
} from "@/lib/import.functions";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Apparatus — import engine for scholarly PDFs" },
      {
        name: "description",
        content:
          "Import a PDF and inspect its extracted structure, apparatus systems and resolved reference links.",
      },
      { property: "og:title", content: "Apparatus — import engine for scholarly PDFs" },
      {
        property: "og:description",
        content: "Import a PDF and inspect structure, apparatus systems and reference resolution.",
      },
    ],
  }),
  component: Library,
});

// Regression corpus only: shortcuts to files already in storage. Nothing in the
// parser knows these documents exist — deleting any entry changes nothing but
// this list.
const BENCHMARKS = [
  { path: "benchmarks/odyssey.pdf", title: "The Odyssey — Mendelsohn (verse, line-keyed commentary)" },
  { path: "benchmarks/pride-and-prejudice.pdf", title: "Pride and Prejudice — Penguin (bracketed endnotes)" },
  { path: "benchmarks/crime-and-punishment.pdf", title: "Crime and Punishment (scanned — no text layer)" },
];

function Library() {
  const qc = useQueryClient();
  const list = useServerFn(listDocuments);
  const runImport = useServerFn(importDocument);
  const step = useServerFn(advanceImport);
  const del = useServerFn(deleteDocument);
  const report = useServerFn(reportImportProgress);
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [phase, setPhase] = useState<string>("");

  const docs = useQuery({ queryKey: ["documents"], queryFn: () => list({}) });

  // Only offer a benchmark shortcut when its file is actually in storage.
  const benchmarkFiles = useQuery({
    queryKey: ["benchmark-files"],
    queryFn: async () => {
      const { data } = await supabase.storage.from("library").list("benchmarks");
      return new Set((data ?? []).map((f) => `benchmarks/${f.name}`));
    },
  });
  const availableBenchmarks = BENCHMARKS.filter((b) => benchmarkFiles.data?.has(b.path));

  /**
   * The browser reads the PDF (classification, OCR, text layer) and stores
   * each result; the server then analyses what was stored. The server never
   * opens the file, so no reading engine ever has to start there.
   */
  async function readThenAnalyse(doc: { id: string; sourcePath: string; title?: string }, retryFailed = false) {
    let last = -1;
    try {
      const { readInBrowser } = await import("@/lib/ingest/run");
      await readInBrowser(doc, {
        ...(retryFailed ? { retryFailed: true } : {}),
        onProgress: async (p) => {
          setPhase(p.label);
          if (p.progress === last && !p.summary) return;
          last = p.progress;
          await report({
            data: {
              id: doc.id,
              status: p.status,
              progress: p.progress,
              error: null,
              ...(p.page_count != null ? { page_count: p.page_count } : {}),
              ...(p.summary ? { summary: p.summary } : {}),
            },
          });
          if (p.summary) qc.invalidateQueries({ queryKey: ["documents"] });
        },
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      await report({ data: { id: doc.id, status: "failed", error: message } }).catch(() => {});
      throw e;
    }
    setPhase("analysing");
    await report({ data: { id: doc.id, status: "extracting", progress: 88 } });
    qc.invalidateQueries({ queryKey: ["documents"] });
    const res = await step({ data: { id: doc.id } });
    setPhase("");
    return res;
  }

  const importMut = useMutation({
    mutationFn: async (input: { storagePath: string; title?: string }) => {
      setBusy(input.storagePath);
      const { id } = await runImport({ data: input });
      qc.invalidateQueries({ queryKey: ["documents"] });
      return readThenAnalyse({ id, sourcePath: input.storagePath, ...(input.title ? { title: input.title } : {}) });
    },
    onSuccess: () => {
      toast.success("Import finished");
      qc.invalidateQueries({ queryKey: ["documents"] });
    },
    onError: (e: Error) => toast.error(e.message),
    onSettled: () => {
      setBusy(null);
      setPhase("");
      qc.invalidateQueries({ queryKey: ["documents"] });
    },
  });

  const resumeMut = useMutation({
    // Resumable: whatever is already stored (classification, OCR pages, text
    // layer) is never redone, unless failed/empty pages are explicitly retried.
    mutationFn: async ({ doc, retryFailed }: { doc: DocumentRow; retryFailed?: boolean }) => {
      setBusy(doc.id);
      const sourcePath = String(doc.summary?.["sourcePath"] ?? "");
      if (!sourcePath) throw new Error("This document has no stored PDF.");
      return readThenAnalyse({ id: doc.id, sourcePath, title: doc.title }, retryFailed === true);
    },
    onSuccess: () => {
      toast.success("Import finished");
      qc.invalidateQueries({ queryKey: ["documents"] });
    },
    onError: (e: Error) => toast.error(e.message),
    onSettled: () => {
      setBusy(null);
      setPhase("");
      qc.invalidateQueries({ queryKey: ["documents"] });
    },
  });

  async function onFile(file: File) {
    const path = `uploads/${crypto.randomUUID()}-${file.name.replace(/[^\w.-]+/g, "_")}`;
    setBusy(path);
    const up = await supabase.storage.from("library").upload(path, file, { contentType: "application/pdf" });
    if (up.error) {
      setBusy(null);
      toast.error(up.error.message);
      return;
    }
    importMut.mutate({ storagePath: path, title: file.name.replace(/\.pdf$/i, "") });
  }

  return (
    <main className="mx-auto min-h-screen max-w-5xl px-6 pb-24 pt-16">
      <header className="border-b border-border pb-10">
        <p className="font-mono text-[11px] uppercase tracking-[0.22em] text-muted-foreground">
          Phase 1 · import engine
        </p>
        <h1 className="mt-4 font-serif text-5xl font-light tracking-tight">Apparatus</h1>
        <p className="mt-3 max-w-xl text-sm leading-relaxed text-muted-foreground">
          Extracts structure, line clusters and concurrent editorial systems from a PDF, resolves every
          reference to its target, and stores the artifacts so imports can be re-opened and debugged
          without re-running extraction.
        </p>
      </header>

      <section className="mt-10 grid gap-3 sm:grid-cols-2">
        <div className="rounded-lg border border-border bg-card p-5">
          <h2 className="font-serif text-lg">Import a PDF</h2>
          <p className="mt-1 text-xs text-muted-foreground">Uploaded to storage, read in your browser, then analysed.</p>
          <input
            ref={fileRef}
            type="file"
            accept="application/pdf"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void onFile(f);
              e.target.value = "";
            }}
          />
          <Button
            className="mt-4"
            disabled={!!busy}
            onClick={() => fileRef.current?.click()}
          >
            {busy?.startsWith("uploads/") ? phase || "Working…" : "Choose file"}
          </Button>
        </div>

        <div className="rounded-lg border border-border bg-card p-5">
          <h2 className="font-serif text-lg">Benchmarks</h2>
          <p className="mt-1 text-xs text-muted-foreground">The two reference editions used to tune the engine.</p>
          <div className="mt-4 flex flex-col gap-2">
            {availableBenchmarks.length === 0 && (
              <p className="text-xs text-muted-foreground">
                No benchmark files are stored yet — import your own PDF above.
              </p>
            )}
            {availableBenchmarks.map((b) => (
              <Button
                key={b.path}
                variant="outline"
                className="justify-start text-left"
                disabled={!!busy}
                onClick={() => importMut.mutate({ storagePath: b.path, title: b.title.split(" — ")[0]! })}
              >
                {busy === b.path ? phase || "Parsing…" : b.title}
              </Button>
            ))}
          </div>
        </div>
      </section>

      <section className="mt-14">
        <h2 className="font-mono text-[11px] uppercase tracking-[0.22em] text-muted-foreground">Library</h2>
        <div className="mt-4 divide-y divide-border border-y border-border">
          {docs.isLoading && <p className="py-6 text-sm text-muted-foreground">Loading…</p>}
          {docs.data?.length === 0 && (
            <p className="py-6 text-sm text-muted-foreground">Nothing imported yet.</p>
          )}
          {docs.data?.map((d) => {
            const s = d.summary ?? {};
            const chips: [string, unknown][] = [
              ["pages", d.page_count],
              ["kind", s["kind"]],
              ["native", s["nativePages"]],
              ["ocr", s["ocrPages"]],
              ["recovered", s["recoveredPages"]],
              ["ocr reused", s["ocrReusedPages"]],
              ["ocr conf", s["ocrMeanConfidence"]],
              ["ocr failed", s["ocrFailedPages"]],
              ["blocks", s["blocks"]],
              ["sections", s["sections"]],
              ["systems", s["systems"]],
              ["refs", s["refs"]],
              ["unresolved", s["unresolved"]],
            ];
            return (
              <div key={d.id} className="flex items-center gap-4 py-5">
                <div className="min-w-0 flex-1">
                  <Link
                    to="/read/$id"
                    params={{ id: d.id }}
                    className="font-serif text-xl hover:underline"
                  >
                    {d.title}
                  </Link>
                  <Link
                    to="/doc/$id"
                    params={{ id: d.id }}
                    className="ml-3 font-mono text-[11px] text-muted-foreground underline"
                  >
                    inspector
                  </Link>
                  <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 font-mono text-[11px] text-muted-foreground">
                    <span
                      className={
                        d.status === "ready" && s["readiness"] === "ready"
                          ? "text-ok"
                          : d.status === "failed" || d.status === "unreadable"
                            ? "text-bad"
                            : "text-warn"
                      }
                    >
                      {d.status}
                      {s["readiness"] && s["readiness"] !== d.status ? ` · ${String(s["readiness"])}` : ""}
                    </span>
                    {chips
                      .filter(([, v]) => v != null)
                      .map(([k, v]) => (
                        <span key={k}>
                          {k} <span className="text-foreground">{String(v)}</span>
                        </span>
                      ))}
                  </div>
                  {d.error && <p className="mt-2 text-xs text-bad">{d.error}</p>}
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!!busy}
                  onClick={() => resumeMut.mutate({ doc: d })}
                  title="continue an interrupted import, or re-run analysis over the stored OCR"
                >
                  {busy === d.id ? phase || "Working…" : d.status === "ready" ? "Re-analyze" : "Resume"}
                </Button>
                {Number(s["ocrFailedPages"] ?? 0) + Number(s["ocrEmptyPages"] ?? 0) > 0 && (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!!busy}
                    onClick={() => resumeMut.mutate({ doc: d, retryFailed: true })}
                    title="re-run OCR only on the pages that failed or came back empty"
                  >
                    Retry failed pages
                  </Button>
                )}


                <Button
                  variant="ghost"
                  size="sm"
                  className="text-muted-foreground"
                  onClick={async () => {
                    await del({ data: { id: d.id } });
                    qc.invalidateQueries({ queryKey: ["documents"] });
                  }}
                >
                  Delete
                </Button>
              </div>
            );
          })}
        </div>
      </section>
    </main>
  );
}
