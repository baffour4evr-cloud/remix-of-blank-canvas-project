import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import type { ModelArtifact } from "@/lib/reader/artifacts";
import type { Block, RefEdge } from "@/lib/reader/types";
import { useBlockResolver, useRefIndex, useRefNav } from "@/lib/reader/useDoc";

const METHOD_TONE: Record<string, string> = {
  marker: "text-ok",
  "lemma-match": "text-ok",
  "line-key": "text-ok",
  annotation: "text-ok",
  heuristic: "text-warn",
  unresolved: "text-bad",
};

export function RefsView({ id, model }: { id: string; model: ModelArtifact }) {
  const { refs, incoming, outgoing, byId } = useRefIndex(model);
  const nav = useRefNav();
  const [type, setType] = useState("all");
  const [method, setMethod] = useState("all");
  const [q, setQ] = useState("");
  const resolve = useBlockResolver(id, model);

  const types = useMemo(() => ["all", ...new Set(refs.map((r) => r.type))], [refs]);
  const methods = useMemo(() => ["all", ...new Set(refs.map((r) => r.method))], [refs]);
  const filtered = useMemo(
    () =>
      refs.filter(
        (r) =>
          (type === "all" || r.type === type) &&
          (method === "all" || r.method === method) &&
          (!q || r.label.toLowerCase().includes(q.toLowerCase())),
      ),
    [refs, type, method, q],
  );

  const current = nav.current ? byId.get(nav.current.refId) ?? null : null;

  return (
    <div className="space-y-12">
    <div className="grid gap-8 lg:grid-cols-[minmax(0,380px)_minmax(0,1fr)]">
      <section className="min-w-0">
        <div className="flex flex-wrap gap-2">
          <Select value={type} onChange={setType} options={types} label="type" />
          <Select value={method} onChange={setMethod} options={methods} label="method" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="filter labels"
            className="min-w-32 flex-1 rounded-md border border-input bg-background px-2 py-1 font-mono text-xs"
          />
        </div>
        <p className="mt-3 font-mono text-[11px] text-muted-foreground">
          {filtered.length} of {refs.length} references
        </p>
        <ul className="mt-2 max-h-[70vh] divide-y divide-border overflow-auto border-y border-border">
          {filtered.slice(0, 600).map((r) => (
            <li key={r.id}>
              <button
                onClick={() => nav.go({ refId: r.id, side: "source" })}
                className={`w-full px-1 py-2 text-left hover:bg-accent ${
                  current?.id === r.id ? "bg-accent" : ""
                }`}
              >
                <div className="flex items-baseline gap-3">
                  <span className="font-serif text-sm">{r.label}</span>
                  <span className={`ml-auto font-mono text-[10px] ${METHOD_TONE[r.method] ?? ""}`}>
                    {r.method}
                  </span>
                </div>
                <div className="mt-0.5 flex gap-3 font-mono text-[10px] text-muted-foreground">
                  <span>{r.type}</span>
                  <span>p{model.blockPage[r.from] ?? "?"}</span>
                  <span>→ {r.to ? `p${model.blockPage[r.to] ?? "?"}` : r.toSection ? "section" : "—"}</span>
                  <span>{(r.confidence * 100).toFixed(0)}%</span>
                </div>
              </button>
            </li>
          ))}
        </ul>
      </section>

      <section className="min-w-0">
        {!current && (
          <p className="text-sm text-muted-foreground">
            Select a reference to trace it. You can walk from an occurrence to its target and back,
            with history.
          </p>
        )}
        {current && (
          <Trace
            model={model}
            edge={current}
            side={nav.current!.side}
            resolve={resolve}
            incoming={incoming}
            outgoing={outgoing}
            byId={byId}
            nav={nav}
          />
        )}
      </section>
    </div>
    <RecognitionLog model={model} />
    </div>
  );
}

const DECISION_TONE: Record<string, string> = {
  accepted: "text-ok",
  merged: "text-muted-foreground",
  "accepted-unresolved": "text-warn",
  rejected: "text-bad",
};

/** Every reference candidate the engine considered, and why it was kept or not. */
function RecognitionLog({ model }: { model: ModelArtifact }) {
  const records = model.diagnostics.recognition ?? [];
  const profiles = model.diagnostics.referenceSystems ?? [];
  const [decision, setDecision] = useState("all");
  const [q, setQ] = useState("");
  const decisions = useMemo(() => ["all", ...new Set(records.map((r) => r.decision))], [records]);
  const shown = records.filter(
    (r) => (decision === "all" || r.decision === decision) && (!q || r.text.toLowerCase().includes(q.toLowerCase())),
  );
  if (!records.length) {
    return (
      <p className="font-mono text-[11px] text-muted-foreground">
        No recognition log for this import — re-analyze to record one.
      </p>
    );
  }
  return (
    <section>
      <h3 className="font-mono text-[11px] uppercase tracking-[0.22em] text-muted-foreground">
        Reference systems discovered
      </h3>
      <ul className="mt-2 space-y-1 font-mono text-[11px]">
        {profiles.map((p) => (
          <li key={p.system}>
            <span className="text-foreground">{p.label}</span> · {p.kind} · {p.grammar} · {p.entryCount} entries ·
            keys {p.vocabulary.slice(0, 8).join(" ")}
            {p.vocabulary.length > 8 ? " …" : ""} · resets {p.resets} · set as{" "}
            {Object.entries(p.sourceSettings).map(([k, v]) => `${k} ${v}`).join(", ") || "—"}
            {p.sharesKeysWith.length ? ` · shares keys with ${p.sharesKeysWith.join(", ")}` : ""}
          </li>
        ))}
      </ul>

      <h3 className="mt-8 font-mono text-[11px] uppercase tracking-[0.22em] text-muted-foreground">
        Recognition log
      </h3>
      <div className="mt-2 flex flex-wrap gap-2">
        <Select value={decision} onChange={setDecision} options={decisions} label="decision" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="filter source text"
          className="min-w-32 flex-1 rounded-md border border-input bg-background px-2 py-1 font-mono text-xs"
        />
      </div>
      <p className="mt-2 font-mono text-[11px] text-muted-foreground">
        {shown.length} of {records.length} candidates
      </p>
      <div className="mt-2 max-h-[60vh] overflow-auto border-y border-border">
        <table className="w-full font-mono text-[10px]">
          <thead className="sticky top-0 bg-background text-left text-muted-foreground">
            <tr>
              <th className="p-1">source</th>
              <th className="p-1">range</th>
              <th className="p-1">method</th>
              <th className="p-1">system</th>
              <th className="p-1">signals</th>
              <th className="p-1">recog.</th>
              <th className="p-1">dest.</th>
              <th className="p-1">decision</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {shown.slice(0, 800).map((r) => (
              <tr key={r.id} className="align-top">
                <td className="p-1 font-serif text-xs">{r.text}</td>
                <td className="p-1">
                  {r.blockId}:{r.start}–{r.end}
                </td>
                <td className="p-1">{r.method}</td>
                <td className="p-1">{r.system ?? "—"}</td>
                <td className="p-1">{r.signals.join(" · ")}</td>
                <td className="p-1">{(r.recognition * 100).toFixed(0)}%</td>
                <td className="p-1">
                  {r.destination ?? "—"} {r.destination ? `(${(r.destinationConfidence * 100).toFixed(0)}%)` : ""}
                  {r.alternatives.length ? (
                    <div className="text-muted-foreground">
                      {r.alternatives.map((a) => `${a.to} ${a.score}`).join(", ")}
                    </div>
                  ) : null}
                </td>
                <td className="p-1">
                  <span className={DECISION_TONE[r.decision] ?? ""}>{r.decision}</span>
                  <div className="text-muted-foreground">{r.reason}</div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Trace({
  model,
  edge,
  side,
  resolve,
  incoming,
  outgoing,
  byId,
  nav,
}: {
  model: ModelArtifact;
  edge: RefEdge;
  side: "source" | "target";
  resolve: (id: string) => Promise<Block | null>;
  incoming: Map<string, string[]>;
  outgoing: Map<string, string[]>;
  byId: Map<string, RefEdge>;
  nav: ReturnType<typeof useRefNav>;
}) {
  const from = useQuery({
    queryKey: ["block", edge.from],
    queryFn: () => resolve(edge.from),
    staleTime: Infinity,
  });
  const to = useQuery({
    queryKey: ["block", edge.to],
    queryFn: () => (edge.to ? resolve(edge.to) : Promise.resolve(null)),
    enabled: !!edge.to,
    staleTime: Infinity,
  });
  const section = edge.toSection ? model.structure.find((s) => s.id === edge.toSection) : null;
  const focusBlockId = side === "source" ? edge.from : edge.to;
  const siblings = focusBlockId
    ? [
        ...(incoming.get(focusBlockId) ?? []),
        ...(outgoing.get(focusBlockId) ?? []),
      ].filter((rid) => rid !== edge.id)
    : [];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" disabled={!nav.canBack} onClick={nav.back}>
          ← Back
        </Button>
        <Button size="sm" variant="outline" disabled={!nav.canForward} onClick={nav.forward}>
          Forward →
        </Button>
        <Button size="sm" onClick={nav.flip} disabled={!edge.to}>
          {side === "source" ? "Jump to target" : "Return to occurrence"}
        </Button>
        <span className="font-mono text-[11px] text-muted-foreground">
          step {nav.index + 1}/{nav.stack.length}
        </span>
      </div>

      <div className="rounded-lg border border-border bg-card p-5">
        <div className="flex flex-wrap gap-x-5 gap-y-1 font-mono text-[11px] text-muted-foreground">
          <span className="text-foreground">{edge.type}</span>
          <span className={METHOD_TONE[edge.method] ?? ""}>{edge.method}</span>
          <span>confidence {(edge.confidence * 100).toFixed(0)}%</span>
          <span>system {edge.system ?? "—"}</span>
          <span>offset {edge.at}</span>
        </div>
        {edge.note && <p className="mt-2 text-xs text-warn">{edge.note}</p>}
      </div>

      <Panel
        active={side === "source"}
        caption={`occurrence · p${model.blockPage[edge.from] ?? "?"}`}
        block={from.data ?? null}
        anchor={{ at: edge.at, label: edge.label }}
        onFocus={() => nav.go({ refId: edge.id, side: "source" })}
      />

      <div className="text-center font-mono text-[11px] text-muted-foreground">
        {edge.to ? "resolves to" : section ? "resolves to section" : "unresolved"}
      </div>

      {edge.to ? (
        <Panel
          active={side === "target"}
          caption={`target · p${model.blockPage[edge.to] ?? "?"}`}
          block={to.data ?? null}
          onFocus={() => nav.go({ refId: edge.id, side: "target" })}
        />
      ) : section ? (
        <div className="rounded-lg border border-border bg-card p-5">
          <p className="font-serif text-lg">{section.label}</p>
          <p className="font-mono text-[11px] text-muted-foreground">
            {section.type} · page {section.page}
          </p>
        </div>
      ) : (
        <div className="rounded-lg border border-dashed border-bad/50 p-5 text-sm text-bad">
          No target found for “{edge.label}”.
        </div>
      )}

      {!!siblings.length && (
        <div>
          <h4 className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
            other references touching this block · {siblings.length}
          </h4>
          <ul className="mt-2 flex flex-wrap gap-2">
            {siblings.slice(0, 30).map((rid) => {
              const r = byId.get(rid)!;
              return (
                <li key={rid}>
                  <button
                    onClick={() => nav.go({ refId: rid, side: r.to === focusBlockId ? "target" : "source" })}
                    className="rounded-full border border-border px-3 py-1 font-mono text-[11px] hover:bg-accent"
                  >
                    {r.label}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}

function Panel({
  caption,
  block,
  anchor,
  active,
  onFocus,
}: {
  caption: string;
  block: Block | null;
  anchor?: { at: number; label: string };
  active: boolean;
  onFocus: () => void;
}) {
  return (
    <div
      onClick={onFocus}
      className={`cursor-pointer rounded-lg border bg-card p-5 transition-colors ${
        active ? "border-foreground/40" : "border-border"
      }`}
    >
      <div className="flex flex-wrap gap-x-4 font-mono text-[11px] text-muted-foreground">
        <span>{caption}</span>
        {block?.type && <span className="text-foreground">{block.type}</span>}
        {block?.line != null && <span>line {block.line}</span>}
        {block?.key && <span>key {block.key}</span>}
      </div>
      {!block && <p className="mt-2 text-sm text-muted-foreground">Loading…</p>}
      {block && (
        <p className="mt-2 font-serif text-[15px] leading-relaxed">
          {anchor ? highlight(block.text, anchor.at, anchor.label) : block.text}
        </p>
      )}
    </div>
  );
}

function highlight(text: string, at: number, label: string) {
  const len = Math.min(label.length, 40);
  if (at < 0 || at > text.length) return text;
  return (
    <>
      {text.slice(0, at)}
      <mark className="rounded bg-warn/30 px-0.5">{text.slice(at, at + Math.max(1, len))}</mark>
      {text.slice(at + Math.max(1, len))}
    </>
  );
}

function Select({
  value,
  onChange,
  options,
  label,
}: {
  value: string;
  onChange: (v: string) => void;
  options: string[];
  label: string;
}) {
  return (
    <label className="flex items-center gap-1 rounded-md border border-input bg-background px-2 py-1">
      <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="bg-transparent font-mono text-xs outline-none"
      >
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </label>
  );
}
