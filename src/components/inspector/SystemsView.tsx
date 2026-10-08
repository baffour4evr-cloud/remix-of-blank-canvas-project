import type { ModelArtifact } from "@/lib/reader/artifacts";
import type { StageStatus } from "@/lib/reader/stages";

const STAGE_TONE: Record<StageStatus, string> = {
  ok: "text-ok",
  warn: "text-warn",
  failed: "text-bad",
  skipped: "text-muted-foreground",
};

function PipelineReport({ model }: { model: ModelArtifact }) {
  const { readiness, stages, issues } = model.diagnostics;
  return (
    <section>
      <h3 className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
        import pipeline ·{" "}
        <span
          className={
            readiness === "ready" ? "text-ok" : readiness === "degraded" ? "text-warn" : "text-bad"
          }
        >
          {readiness}
        </span>
      </h3>
      <ol className="mt-3 divide-y divide-border border-y border-border">
        {(stages ?? []).map((s) => (
          <li key={s.id} className="py-3">
            <div className="flex items-baseline gap-3">
              <span className={`w-16 shrink-0 font-mono text-[10px] uppercase ${STAGE_TONE[s.status]}`}>
                {s.status}
              </span>
              <span className="font-serif text-sm">{s.label}</span>
              <span className="ml-auto flex flex-wrap justify-end gap-x-3 font-mono text-[10px] text-muted-foreground">
                {Object.entries(s.metrics).map(([k, v]) => (
                  <span key={k}>
                    {k} <span className="text-foreground">{String(v)}</span>
                  </span>
                ))}
              </span>
            </div>
            <ul className="mt-1 pl-[4.75rem] text-xs text-muted-foreground">
              {s.notes.map((n, i) => (
                <li key={i} className="pl-3 -indent-3">
                  · {n}
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ol>
      <ul className="mt-3 space-y-1">
        {(issues ?? []).map((i, k) => (
          <li key={k} className="text-xs">
            <span
              className={`font-mono text-[10px] uppercase ${
                i.severity === "error" ? "text-bad" : i.severity === "warn" ? "text-warn" : "text-muted-foreground"
              }`}
            >
              {i.severity} · {i.code}
            </span>{" "}
            <span className="text-muted-foreground">{i.message}</span>
          </li>
        ))}
        {!issues?.length && <li className="text-xs text-ok">No stage reported a problem.</li>}
      </ul>
    </section>
  );
}

export function SystemsView({ model }: { model: ModelArtifact }) {
  const counts = model.diagnostics.counts;
  return (
    <div className="space-y-10">
      <PipelineReport model={model} />
      <section>
        <h3 className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
          reference systems · {model.systems.length}
        </h3>
        <div className="mt-4 grid gap-4 md:grid-cols-2">
          {model.systems.map((s) => (
            <article key={s.id} className="rounded-lg border border-border bg-card p-5">
              <div className="flex items-baseline justify-between gap-3">
                <h4 className="font-serif text-lg">{s.label}</h4>
                <span
                  className={`font-mono text-[11px] ${
                    s.confidence > 0.9 ? "text-ok" : s.confidence > 0.7 ? "text-warn" : "text-bad"
                  }`}
                >
                  {(s.confidence * 100).toFixed(0)}%
                </span>
              </div>
              <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 font-mono text-[11px] text-muted-foreground">
                <span>{s.kind}</span>
                <span>grammar {s.grammar}</span>
                <span>scope {s.keyScope}</span>
                <span>entries {s.entryCount}</span>
              </div>
              <ul className="mt-3 space-y-1 text-xs leading-relaxed text-muted-foreground">
                {s.evidence.map((e, i) => (
                  <li key={i} className="pl-3 -indent-3">
                    · {e}
                  </li>
                ))}
              </ul>
              {s.samples[0] && (
                <p className="mt-3 border-l-2 border-border pl-3 font-serif text-sm">
                  <span className="font-mono text-[11px] text-muted-foreground">{s.samples[0].key}</span>{" "}
                  {s.samples[0].text}
                </p>
              )}
            </article>
          ))}
        </div>
      </section>

      <section>
        <h3 className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
          diagnostics
        </h3>
        <dl className="mt-4 grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-border bg-border sm:grid-cols-4">
          {[
            ["body size", model.diagnostics.bodySize],
            ["body indent", model.diagnostics.bodyIndent],
            ["furniture dropped", model.diagnostics.droppedFurniture],
            ["verse sections", model.diagnostics.verseSections],
            ...Object.entries(counts),
          ].map(([k, v]) => (
            <div key={String(k)} className="bg-card p-4">
              <dt className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">{k}</dt>
              <dd className="mt-1 font-serif text-2xl font-light">{String(v)}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section>
        <h3 className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
          unresolved · {model.diagnostics.unresolved.length}
        </h3>
        <ul className="mt-3 divide-y divide-border border-y border-border">
          {model.diagnostics.unresolved.slice(0, 60).map((u, i) => (
            <li key={i} className="flex flex-wrap gap-x-4 py-2 font-mono text-[11px]">
              <span className="text-bad">{u.label}</span>
              <span className="text-muted-foreground">{u.reason}</span>
              <span className="text-muted-foreground">{u.from}</span>
            </li>
          ))}
          {!model.diagnostics.unresolved.length && (
            <li className="py-3 text-sm text-ok">Everything resolved.</li>
          )}
        </ul>
      </section>
    </div>
  );
}

export function OutlineView({ model }: { model: ModelArtifact }) {
  return (
    <ul className="divide-y divide-border border-y border-border">
      {model.structure.map((s) => (
        <li key={s.id} className="flex items-baseline gap-4 py-2">
          <span className="w-12 shrink-0 text-right font-mono text-[11px] text-muted-foreground">
            p{s.page}
          </span>
          <span style={{ paddingLeft: s.depth * 18 }} className="font-serif text-sm">
            {s.label}
            {s.title && s.title !== s.label ? ` — ${s.title}` : ""}
          </span>
          <span className="ml-auto flex gap-3 font-mono text-[10px] text-muted-foreground">
            <span>{s.type}</span>
            {s.verse && <span className="text-ok">verse</span>}
            <span>{s.end - s.start} blocks</span>
          </span>
        </li>
      ))}
    </ul>
  );
}
