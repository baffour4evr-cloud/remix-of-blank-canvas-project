import { useMemo, useState } from "react";

import { useChunk } from "@/lib/reader/useDoc";
import type { ModelArtifact } from "@/lib/reader/artifacts";
import { chunkOfPage } from "@/lib/reader/artifacts";

export function PageView({ id, model }: { id: string; model: ModelArtifact }) {
  const [page, setPage] = useState(1);
  const [hover, setHover] = useState<number | null>(null);
  const chunk = useChunk(id, chunkOfPage(page, model.chunkPages));
  const spans = chunk.data?.pages.find((p) => p.page === page);
  const blocks = useMemo(
    () => (chunk.data?.blocks ?? []).filter((b) => b.page === page),
    [chunk.data, page],
  );
  const sectionOf = useMemo(
    () => new Map(model.structure.map((s) => [s.id, s])),
    [model.structure],
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <label className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
          page
        </label>
        <input
          type="number"
          min={1}
          max={model.pageCount}
          value={page}
          onChange={(e) => setPage(Math.min(model.pageCount, Math.max(1, Number(e.target.value) || 1)))}
          className="w-24 rounded-md border border-input bg-background px-2 py-1 font-mono text-sm"
        />
        <input
          type="range"
          min={1}
          max={model.pageCount}
          value={page}
          onChange={(e) => setPage(Number(e.target.value))}
          className="h-1 flex-1 accent-foreground"
        />
        <span className="font-mono text-[11px] text-muted-foreground">of {model.pageCount}</span>
      </div>

      {chunk.isLoading && <p className="text-sm text-muted-foreground">Loading page artifacts…</p>}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,260px)_minmax(0,1fr)_minmax(0,1fr)]">
        <section>
          <Caption>geometry</Caption>
          {spans && (
            <div
              className="relative mt-2 border border-border bg-card"
              style={{ width: 240, height: (240 * spans.height) / spans.width }}
            >
              {spans.lines.map((l, i) => {
                const k = 240 / spans.width;
                return (
                  <div
                    key={i}
                    onMouseEnter={() => setHover(i)}
                    onMouseLeave={() => setHover(null)}
                    title={l.text}
                    className={`absolute ${
                      l.furniture ? "bg-bad/35" : "bg-foreground/25"
                    } ${hover === i ? "outline outline-1 outline-ring" : ""}`}
                    style={{
                      left: l.x * k,
                      top: (spans.height - l.y - l.size) * k,
                      width: Math.max(1, (l.right - l.x) * k),
                      height: Math.max(1.5, l.size * k * 0.8),
                    }}
                  />
                );
              })}
              {spans.links.map((ln, i) => {
                const k = 240 / spans.width;
                return (
                  <div
                    key={`l${i}`}
                    className="absolute border border-ok/70"
                    style={{
                      left: ln.x * k,
                      top: (spans.height - ln.y - ln.h) * k,
                      width: Math.max(1, ln.w * k),
                      height: Math.max(1, ln.h * k),
                    }}
                  />
                );
              })}
            </div>
          )}
          <p className="mt-3 font-mono text-[11px] leading-relaxed text-muted-foreground">
            <span className="mr-2 inline-block h-2 w-3 bg-foreground/25 align-middle" /> line cluster
            <br />
            <span className="mr-2 inline-block h-2 w-3 bg-bad/35 align-middle" /> dropped furniture
            <br />
            <span className="mr-2 inline-block h-2 w-3 border border-ok/70 align-middle" /> link annotation
          </p>
        </section>

        <section className="min-w-0">
          <Caption>line clusters · {spans?.lines.length ?? 0}</Caption>
          <ul className="mt-2 divide-y divide-border border-y border-border">
            {spans?.lines.map((l, i) => (
              <li
                key={i}
                onMouseEnter={() => setHover(i)}
                onMouseLeave={() => setHover(null)}
                className={`py-2 ${hover === i ? "bg-accent" : ""}`}
              >
                <div className="flex gap-3 font-mono text-[10px] text-muted-foreground">
                  <span>y{l.y.toFixed(0)}</span>
                  <span>x{l.x.toFixed(0)}</span>
                  <span>w{(l.right - l.x).toFixed(0)}</span>
                  <span>s{l.size}</span>
                  {l.furniture && <span className="text-bad">furniture</span>}
                  {l.runs.some((r) => r.sup) && <span className="text-warn">sup</span>}
                  {l.runs.some((r) => r.em) && <span className="text-ok">italic</span>}
                </div>
                <p className="mt-1 font-serif text-sm leading-snug">{l.text}</p>
              </li>
            ))}
          </ul>
        </section>

        <section className="min-w-0">
          <Caption>blocks · {blocks.length}</Caption>
          <ul className="mt-2 space-y-3">
            {blocks.map((b) => (
              <li key={b.id} className="rounded-md border border-border bg-card p-3">
                <div className="flex flex-wrap gap-3 font-mono text-[10px] text-muted-foreground">
                  <span className="text-foreground">{b.type}</span>
                  {b.line != null && <span>line {b.line}</span>}
                  {b.key && <span>key {b.key}</span>}
                  {b.system && <span>{b.system}</span>}
                  <span className="truncate">{sectionOf.get(b.section)?.label ?? b.section}</span>
                </div>
                {b.lemma && <p className="mt-1 font-serif text-xs italic text-muted-foreground">{b.lemma}</p>}
                <p className="mt-1 font-serif text-sm leading-relaxed">{b.text}</p>
              </li>
            ))}
            {!blocks.length && !chunk.isLoading && (
              <li className="text-sm text-muted-foreground">No blocks on this page.</li>
            )}
          </ul>
        </section>
      </div>
    </div>
  );
}

function Caption({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground">{children}</h3>
  );
}
