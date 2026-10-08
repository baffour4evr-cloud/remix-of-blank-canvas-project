import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useMemo, useState } from "react";

import { searchDocument, type SearchHit } from "@/lib/import.functions";
import type { ModelArtifact } from "@/lib/reader/artifacts";
import type { RefEdge, StructureNode } from "@/lib/reader/types";

const label = "font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground";

export function StructurePanel({
  model,
  onJump,
}: {
  model: ModelArtifact;
  onJump: (blockId: string) => void;
}) {
  const orderToId = useOrderMap(model);
  const nodes = model.structure.filter((s) => s.type !== "root");
  return (
    <div>
      <p className={label}>structure · {nodes.length} nodes</p>
      <ul className="mt-2">
        {nodes.map((s: StructureNode) => (
          <li key={s.id}>
            <button
              onClick={() => {
                const bid = orderToId.get(s.start);
                if (bid) onJump(bid);
              }}
              style={{ paddingLeft: `${Math.max(0, s.depth - 1) * 12}px` }}
              className="block w-full truncate py-1 text-left text-xs hover:text-foreground text-muted-foreground"
              title={`${s.type} · blocks ${s.start}–${s.end} · p${s.page}`}
            >
              <span className="mr-2 font-mono text-[10px] text-foreground/60">{s.type}</span>
              {s.label}
              {s.title ? ` — ${s.title}` : ""}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function SystemsPanel({
  model,
  active,
  setActive,
  onJump,
}: {
  model: ModelArtifact;
  active: Set<string> | null;
  setActive: (s: Set<string> | null) => void;
  onJump: (blockId: string) => void;
}) {
  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of model.refs) if (r.system) m.set(r.system, (m.get(r.system) ?? 0) + 1);
    return m;
  }, [model.refs]);

  const toggle = (sysId: string) => {
    const next = new Set(active ?? []);
    if (next.has(sysId)) next.delete(sysId);
    else next.add(sysId);
    setActive(next.size ? next : null);
  };

  return (
    <div>
      <div className="flex items-center justify-between">
        <p className={label}>systems · {model.systems.length}</p>
        <button className="font-mono text-[10px] text-muted-foreground hover:text-foreground" onClick={() => setActive(null)}>
          show all
        </button>
      </div>
      <ul className="mt-2 space-y-2">
        {model.systems.map((s) => {
          const on = !active || active.has(s.id);
          return (
            <li key={s.id} className={`rounded border border-border p-2 ${on ? "" : "opacity-40"}`}>
              <button className="w-full text-left" onClick={() => toggle(s.id)}>
                <p className="text-xs">{s.label}</p>
                <p className="mt-1 font-mono text-[10px] text-muted-foreground">
                  {s.kind} · {s.grammar} · scope {s.keyScope} · {s.entryCount} entries · {counts.get(s.id) ?? 0} refs ·{" "}
                  {Math.round(s.confidence * 100)}%
                </p>
              </button>
              <ul className="mt-1">
                {s.evidence.slice(0, 3).map((e, i) => (
                  <li key={i} className="font-mono text-[10px] leading-4 text-muted-foreground">
                    · {e}
                  </li>
                ))}
              </ul>
              <button
                className="mt-1 font-mono text-[10px] text-muted-foreground underline hover:text-foreground"
                onClick={() => {
                  const first = model.refs.find((r) => r.system === s.id);
                  if (first) onJump(first.from);
                }}
              >
                jump to first reference
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function SearchPanel({
  id,
  model,
  onJump,
}: {
  id: string;
  model: ModelArtifact;
  onJump: (blockId: string) => void;
}) {
  const fn = useServerFn(searchDocument);
  const [q, setQ] = useState("");
  const [submitted, setSubmitted] = useState("");
  const res = useQuery({
    queryKey: ["search", id, submitted],
    queryFn: () => fn({ data: { id, q: submitted } }) as Promise<SearchHit[]>,
    enabled: submitted.length > 1,
    staleTime: 1000 * 60,
  });
  const sections = useMemo(() => new Map(model.structure.map((s) => [s.id, s])), [model.structure]);

  return (
    <div>
      <p className={label}>search · normalized document</p>
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && setSubmitted(q)}
        placeholder="type and press enter"
        className="mt-2 w-full rounded border border-input bg-background px-2 py-1 font-mono text-xs"
      />
      {res.isFetching && <p className="mt-2 font-mono text-[10px] text-muted-foreground">searching…</p>}
      {res.data && (
        <p className="mt-2 font-mono text-[10px] text-muted-foreground">{res.data.length} hits</p>
      )}
      <ul className="mt-1 divide-y divide-border">
        {res.data?.map((h) => (
          <li key={h.blockId}>
            <button className="w-full py-2 text-left" onClick={() => onJump(h.blockId)}>
              <p className="font-mono text-[10px] text-muted-foreground">
                p{h.page} · {sections.get(h.section)?.label ?? h.section} · {h.blockId} · {h.type}
              </p>
              <p className="mt-0.5 line-clamp-2 text-xs">…{h.snippet}…</p>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function RefDetail({
  model,
  ref: edge,
  sourcePage,
  targetPage,
  onGoTarget,
  onGoSource,
}: {
  model: ModelArtifact;
  ref: RefEdge;
  sourcePage: number | undefined;
  targetPage: number | undefined;
  onGoTarget: () => void;
  onGoSource: () => void;
}) {
  const sys = model.systems.find((s) => s.id === edge.system);
  const unresolvedReason = model.diagnostics.unresolved.find((u) => u.from === edge.from && u.label.includes(edge.label));
  const rows: [string, string][] = [
    ["reference type", edge.type],
    ["system", sys ? `${sys.label} (${sys.kind})` : "none / structural"],
    ["source", `${edge.from} · p${sourcePage ?? "?"} · offset ${edge.at}`],
    ["destination", edge.to ? `${edge.to} · p${targetPage ?? "?"}` : edge.toSection ? `section ${edge.toSection}` : "unresolved"],
    ["method", edge.method],
    ["confidence", `${Math.round(edge.confidence * 100)}%`],
  ];
  return (
    <div className="rounded border border-border bg-card p-3">
      <p className="text-xs">{edge.label}</p>
      <dl className="mt-2 grid grid-cols-[7rem_minmax(0,1fr)] gap-x-2 gap-y-1 font-mono text-[10px]">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-muted-foreground">{k}</dt>
            <dd className="break-words">{v}</dd>
          </div>
        ))}
      </dl>
      {!edge.to && !edge.toSection && (
        <p className="mt-2 font-mono text-[10px] text-bad">
          could not resolve: {unresolvedReason?.reason ?? edge.note ?? "no candidate matched the key in scope"}
        </p>
      )}
      {edge.note && <p className="mt-2 font-mono text-[10px] text-warn">{edge.note}</p>}
      <div className="mt-3 flex gap-2">
        <button
          disabled={!edge.to}
          onClick={onGoTarget}
          className="rounded border border-border px-2 py-1 font-mono text-[10px] disabled:opacity-40"
        >
          go to destination
        </button>
        <button onClick={onGoSource} className="rounded border border-border px-2 py-1 font-mono text-[10px]">
          return to source
        </button>
      </div>
    </div>
  );
}

export function useOrderMap(model: ModelArtifact) {
  return useMemo(() => {
    const m = new Map<number, string>();
    for (const [bid, order] of Object.entries(model.blockOrder)) m.set(order, bid);
    return m;
  }, [model.blockOrder]);
}
