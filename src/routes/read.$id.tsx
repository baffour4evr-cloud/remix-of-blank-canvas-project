import { Link, createFileRoute } from "@tanstack/react-router";
import { useMemo, useRef, useState } from "react";

import { PdfPane } from "@/components/reader/PdfPane";
import { RefDetail, SearchPanel, StructurePanel, SystemsPanel } from "@/components/reader/Panels";
import { RefPopup, type PopupRequest } from "@/components/reader/RefPopup";
import { RefsSidebar } from "@/components/reader/RefsSidebar";
import { ReaderPane } from "@/components/reader/ReaderPane";
import type { RefIndexEntry } from "@/lib/import.functions";
import { refSourceDiagnostics } from "@/lib/reader/diagnose";
import { useNavStack } from "@/lib/reader/navstack";
import type { Block, RefEdge } from "@/lib/reader/types";
import { useModel, useRefIndex, useRefTable } from "@/lib/reader/useDoc";

export const Route = createFileRoute("/read/$id")({
  head: () => ({
    meta: [
      { title: "Parser validation reader — Apparatus" },
      {
        name: "description",
        content:
          "Read the normalized document beside the original PDF, with per-block parser diagnostics, reference resolution traces and structure navigation.",
      },
      { property: "og:title", content: "Parser validation reader — Apparatus" },
      {
        property: "og:description",
        content: "Normalized document beside the source PDF, with parser diagnostics and reference traces.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Reader,
});

type PanelTab = "structure" | "systems" | "references" | "search" | "audit";

interface Trace {
  ref: RefEdge;
  sourceBlock: string;
}

function Reader() {
  const { id } = Route.useParams();
  const model = useModel(id);
  const { refById, outgoing, incoming } = useRefIndexMaps(id, model.data ?? undefined);
  const refTable = useRefTable(id, !!model.data);
  const nav = useNavStack();
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const [debug, setDebug] = useState(true);
  const [diagnostics, setDiagnostics] = useState(false);
  // reader preference: structural navigation edges stay live but unhighlighted
  const [showStructuralRefs, setShowStructuralRefs] = useState(true);
  const [activeSystems, setActiveSystems] = useState<Set<string> | null>(null);
  const [tab, setTab] = useState<PanelTab>("structure");
  const [target, setTarget] = useState<{ blockId: string; nonce: number; top?: number } | null>(null);
  const [focusBlockId, setFocusBlockId] = useState<string | null>(null);
  const [trace, setTrace] = useState<Trace | null>(null);
  const [pdfPage, setPdfPage] = useState(1);
  const [readingPage, setReadingPage] = useState(1);

  const [followPdf, setFollowPdf] = useState(true);
  const [preview, setPreview] = useState<PopupRequest | null>(null);
  const [pinned, setPinned] = useState<PopupRequest[]>([]);
  const [fontScale, setFontScale] = useState(0.95);

  const jump = (blockId: string) => {
    setTarget({ blockId, nonce: Date.now() });
    setFocusBlockId(blockId);
    const p = model.data?.blockPage[blockId];
    if (p) setPdfPage(p);
  };

  /** Follow a reference: remember exactly where we stood, then jump. */
  const follow = (r: RefEdge, sourceBlockId: string) => {
    if (!r.to) return;
    nav.push({ blockId: sourceBlockId, top: scrollRef.current?.scrollTop ?? 0, refId: r.id });
    setTrace({ ref: r, sourceBlock: sourceBlockId });
    setPreview(null);
    jump(r.to);
  };

  const goBack = () => {
    const frame = nav.pop();
    if (!frame) return;
    setFocusBlockId(frame.blockId);
    setTarget({ blockId: frame.blockId, nonce: Date.now(), top: frame.top });
    const p = model.data?.blockPage[frame.blockId];
    if (p) setPdfPage(p);
  };

  const onSelectBlock = (b: Block) => {
    setFocusBlockId(b.id);
    setPdfPage(b.page);
  };

  const onRef = (r: RefEdge, from: Block, e: React.MouseEvent, mode: "preview" | "pin") => {
    const el = e.currentTarget as HTMLElement;
    const para = el.closest<HTMLElement>("[data-block]") ?? el;
    const m = el.getBoundingClientRect();
    const p = para.getBoundingClientRect();
    const req: PopupRequest = {
      ref: r,
      sourceBlock: from,
      markerRect: { top: m.top, bottom: m.bottom, left: m.left, right: m.right },
      paragraphRect: { top: p.top, bottom: p.bottom, left: p.left, right: p.right },
      pinned: mode === "pin",
    };
    setTrace({ ref: r, sourceBlock: from.id });
    if (mode === "pin") {
      setPreview(null);
      setPinned((prev) => (prev.some((x) => x.ref.id === r.id) ? prev : [...prev, req]));
    } else {
      setPreview(req);
    }
  };

  const selectRow = (row: RefIndexEntry) => {
    const r = refById.get(row.id);
    if (r) setTrace({ ref: r, sourceBlock: r.from });
    jump(row.from);
  };

  const openRefIds = useMemo(
    () => new Set([...(preview ? [preview.ref.id] : []), ...pinned.map((p) => p.ref.id)]),
    [preview, pinned],
  );

  const audit = useMemo(() => (model.data ? refSourceDiagnostics(model.data.refs) : []), [model.data]);

  const firstBlockOnPage = useMemo(() => {
    if (!model.data) return () => null as string | null;
    const entries = Object.entries(model.data.blockPage);
    return (page: number) => entries.find(([, p]) => p === page)?.[0] ?? null;
  }, [model.data]);


  return (
    <main className="flex h-screen flex-col">
      <header className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border px-4 py-2">
        <Link to="/" className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground hover:text-foreground">
          ← library
        </Link>
        <Link
          to="/doc/$id"
          params={{ id }}
          className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground hover:text-foreground"
        >
          inspector
        </Link>
        <h1 className="truncate font-serif text-base">{model.data?.title ?? "…"}</h1>
        <div className="ml-auto flex flex-wrap items-center gap-3 font-mono text-[11px]">
          <button
            onClick={goBack}
            disabled={!nav.canBack}
            className="rounded border border-border px-2 py-1 disabled:opacity-30"
            title="return to the position you followed the last reference from"
          >
            ← go back{nav.depth ? ` (${nav.depth})` : ""}
          </button>
          <span className="flex items-center gap-1">
            <button className="rounded border border-border px-1.5" onClick={() => setFontScale((v) => Math.max(0.7, v - 0.1))}>
              A−
            </button>
            <button className="rounded border border-border px-1.5" onClick={() => setFontScale((v) => Math.min(1.5, v + 0.1))}>
              A+
            </button>
          </span>
          {pinned.length > 0 && (
            <button className="rounded border border-border px-2 py-1" onClick={() => setPinned([])}>
              close {pinned.length} pinned
            </button>
          )}
          <Toggle on={debug} set={setDebug} labelText="Debug Mode" />
          <Toggle on={diagnostics} set={setDiagnostics} labelText="Inline diagnostics" />
          <Toggle on={followPdf} set={setFollowPdf} labelText="Sync PDF" />
          <Toggle
            on={showStructuralRefs}
            set={setShowStructuralRefs}
            labelText="Highlight structural refs"
          />
        </div>
      </header>


      {model.isLoading && <p className="p-8 font-mono text-xs text-muted-foreground">loading artifacts…</p>}
      {(model.error || (!model.isLoading && model.data === null)) && (
        <div className="space-y-2 p-8 text-sm">
          <p className="text-bad">
            {model.error
              ? (model.error as Error).message
              : "This document hasn’t finished importing yet, so there is nothing to read here."}
          </p>
          <Link to="/" className="font-mono text-xs underline">
            back to the library
          </Link>
        </div>
      )}

      {model.data && (
        <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[18rem_minmax(0,1.15fr)_minmax(0,1fr)]">
          <aside className="hidden min-h-0 flex-col border-r border-border lg:flex">
            <nav className="flex gap-3 border-b border-border p-3">
              {(["structure", "systems", "references", "search", "audit"] as PanelTab[]).map((t) => (
                <button
                  key={t}
                  onClick={() => setTab(t)}
                  className={`font-mono text-[10px] uppercase tracking-[0.18em] ${
                    tab === t ? "text-foreground underline" : "text-muted-foreground"
                  }`}
                >
                  {t}
                </button>
              ))}
            </nav>
            <div className="min-h-0 flex-1 overflow-auto p-3">
              {tab === "structure" && <StructurePanel model={model.data} onJump={jump} />}
              {tab === "systems" && (
                <SystemsPanel model={model.data} active={activeSystems} setActive={setActiveSystems} onJump={jump} />
              )}
              {tab === "references" && (
                <RefsSidebar
                  model={model.data}
                  rows={refTable.data}
                  loading={refTable.isLoading}
                  currentPage={readingPage}
                  selectedRefId={trace?.ref.id ?? null}
                  onSelect={selectRow}
                  onJumpSource={jump}
                  onJumpDest={jump}
                />
              )}
              {tab === "search" && <SearchPanel id={id} model={model.data} onJump={jump} />}
              {tab === "audit" && (
                <div>
                  <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
                    reference-source audit · {audit.length} findings
                  </p>
                  <ul className="mt-2 divide-y divide-border">
                    {audit.slice(0, 500).map((d, i) => (
                      <li key={i} className="py-1.5">
                        <button
                          className={`text-left font-mono text-[10px] leading-4 ${
                            d.tone === "bad" ? "text-bad" : "text-warn"
                          }`}
                          onClick={() => {
                            const r = refById.get(d.refId);
                            if (r) {
                              setTrace({ ref: r, sourceBlock: r.from });
                              jump(r.from);
                            }
                          }}
                        >
                          {d.refId} · {d.text}
                        </button>
                      </li>
                    ))}
                  </ul>
                  {!audit.length && (
                    <p className="mt-2 font-mono text-[10px] text-ok">every reference is cleanly anchored.</p>
                  )}
                </div>
              )}
            </div>

            {trace && (
              <div className="border-t border-border p-3">
                <RefDetail
                  model={model.data}
                  ref={trace.ref}
                  sourcePage={model.data.blockPage[trace.sourceBlock]}
                  targetPage={trace.ref.to ? model.data.blockPage[trace.ref.to] : undefined}
                  onGoTarget={() => trace.ref.to && follow(trace.ref, trace.sourceBlock)}
                  onGoSource={() => jump(trace.sourceBlock)}
                />
              </div>
            )}
          </aside>

          <section className="min-h-0 border-r border-border">
            <ReaderPane
              id={id}
              model={model.data}
              debug={debug}
              showDiagnostics={diagnostics}
              activeSystems={activeSystems}
              showStructuralRefs={showStructuralRefs}
              target={target}
              focusBlockId={focusBlockId}
              refFocusId={trace?.ref.id ?? null}
              openRefIds={openRefIds}
              outgoing={outgoing}
              incoming={incoming}
              refById={refById}
              scrollRef={scrollRef}
              onSelectBlock={onSelectBlock}
              onRef={onRef}
              onVisiblePage={(p) => {
                setReadingPage(p);
                if (followPdf) setPdfPage(p);
              }}
            />
          </section>

          <section className="hidden min-h-0 lg:block">
            <PdfPane
              id={id}
              page={pdfPage}
              pageCount={model.data.pageCount}
              onPickPage={(p) => {
                setPdfPage(p);
                const b = firstBlockOnPage(p);
                if (b) {
                  setTarget({ blockId: b, nonce: Date.now() });
                  setFocusBlockId(b);
                }
              }}
            />
          </section>
        </div>
      )}

      {model.data && preview && (
        <RefPopup
          docId={id}
          model={model.data}
          req={preview}
          fontScale={fontScale}
          onClose={() => setPreview(null)}
          onPin={() => {
            setPinned((prev) => [...prev, { ...preview, pinned: true }]);
            setPreview(null);
          }}
          onGoToDestination={() => follow(preview.ref, preview.sourceBlock.id)}
          onOpenInSidebar={() => {
            setTab("references");
            setTrace({ ref: preview.ref, sourceBlock: preview.sourceBlock.id });
          }}
        />
      )}
      {model.data &&
        pinned.map((p, i) => (
          <RefPopup
            key={p.ref.id}
            docId={id}
            model={model.data!}
            req={p}
            offset={i + 1}
            fontScale={fontScale}
            onClose={() => setPinned((prev) => prev.filter((x) => x.ref.id !== p.ref.id))}
            onPin={() => undefined}
            onGoToDestination={() => follow(p.ref, p.sourceBlock.id)}
            onOpenInSidebar={() => {
              setTab("references");
              setTrace({ ref: p.ref, sourceBlock: p.sourceBlock.id });
            }}
          />
        ))}

    </main>
  );
}

function Toggle({ on, set, labelText }: { on: boolean; set: (v: boolean) => void; labelText: string }) {
  return (
    <button
      onClick={() => set(!on)}
      className={`rounded border px-2 py-1 ${on ? "border-foreground text-foreground" : "border-border text-muted-foreground"}`}
    >
      {labelText} {on ? "on" : "off"}
    </button>
  );
}

function useRefIndexMaps(_id: string, model: Parameters<typeof useRefIndex>[0]) {
  const idx = useRefIndex(model);
  return { refById: idx.byId, outgoing: idx.outgoing, incoming: idx.incoming };
}
