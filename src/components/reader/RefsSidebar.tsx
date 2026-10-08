import { useMemo, useState } from "react";

import type { RefIndexEntry } from "@/lib/import.functions";
import type { ModelArtifact } from "@/lib/reader/artifacts";

const label = "font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground";

export interface RefsSidebarProps {
  model: ModelArtifact;
  rows: RefIndexEntry[] | undefined;
  loading: boolean;
  /** page currently at the top of the reading pane, for position sync */
  currentPage: number;
  selectedRefId: string | null;
  onSelect: (row: RefIndexEntry) => void;
  onJumpSource: (blockId: string) => void;
  onJumpDest: (blockId: string) => void;
}

/**
 * Every reference in the document, grouped by editorial system, searchable by
 * identifier, type, source sentence or destination text, and synchronized with
 * the reading position.
 */
export function RefsSidebar(props: RefsSidebarProps) {
  const { model, rows } = props;
  const [q, setQ] = useState("");
  const [only, setOnly] = useState<"all" | "unresolved" | "ambiguous">("all");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (rows ?? []).filter((r) => {
      if (only === "unresolved" && r.to) return false;
      if (only === "ambiguous" && !r.ambiguous) return false;
      if (!needle) return true;
      return (
        r.key.toLowerCase().includes(needle) ||
        r.label.toLowerCase().includes(needle) ||
        r.type.includes(needle) ||
        (r.systemLabel ?? "").toLowerCase().includes(needle) ||
        r.sourceSentence.toLowerCase().includes(needle) ||
        r.destText.toLowerCase().includes(needle)
      );
    });
  }, [rows, q, only]);

  const groups = useMemo(() => {
    const m = new Map<string, RefIndexEntry[]>();
    for (const r of filtered) {
      const k = r.systemLabel ?? `structural · ${r.type}`;
      m.set(k, [...(m.get(k) ?? []), r]);
    }
    return [...m.entries()].sort((a, b) => b[1].length - a[1].length);
  }, [filtered]);

  const nearest = useMemo(() => {
    let best: RefIndexEntry | null = null;
    for (const r of filtered) {
      if (r.sourcePage > props.currentPage) break;
      best = r;
    }
    return best?.id ?? null;
  }, [filtered, props.currentPage]);

  return (
    <div>
      <div className="flex items-center justify-between">
        <p className={label}>
          references · {filtered.length}
          {rows ? `/${rows.length}` : ""}
        </p>
        {props.loading && <span className="font-mono text-[10px] text-muted-foreground">indexing…</span>}
      </div>
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="identifier, type, source or destination text"
        className="mt-2 w-full rounded border border-input bg-background px-2 py-1 font-mono text-xs"
      />
      <div className="mt-2 flex gap-2">
        {(["all", "unresolved", "ambiguous"] as const).map((k) => (
          <button
            key={k}
            onClick={() => setOnly(k)}
            className={`font-mono text-[10px] uppercase tracking-[0.14em] ${
              only === k ? "text-foreground underline" : "text-muted-foreground"
            }`}
          >
            {k}
          </button>
        ))}
      </div>

      <div className="mt-3 space-y-3">
        {groups.map(([name, list]) => {
          const open = !collapsed.has(name);
          return (
            <section key={name}>
              <button
                className="flex w-full items-center gap-2 text-left"
                onClick={() =>
                  setCollapsed((prev) => {
                    const next = new Set(prev);
                    if (next.has(name)) next.delete(name);
                    else next.add(name);
                    return next;
                  })
                }
              >
                <span className="font-mono text-[10px] text-muted-foreground">{open ? "▾" : "▸"}</span>
                <span className="text-xs">{name}</span>
                <span className="ml-auto font-mono text-[10px] text-muted-foreground">{list.length}</span>
              </button>
              {open && (
                <ul className="mt-1 divide-y divide-border border-l border-border pl-2">
                  {list.slice(0, 400).map((r) => {
                    const active = props.selectedRefId === r.id;
                    return (
                      <li
                        key={r.id}
                        className={`py-1.5 ${active ? "bg-warn/10" : nearest === r.id ? "bg-accent/40" : ""}`}
                      >
                        <button className="w-full text-left" onClick={() => props.onSelect(r)}>
                          <p className="font-mono text-[10px] text-muted-foreground">
                            {r.key} · {r.type} · p{r.sourcePage}
                            {r.destPage ? ` → p${r.destPage}` : " → unresolved"} · {Math.round(r.confidence * 100)}%
                          </p>
                          <p className="mt-0.5 line-clamp-2 text-xs">{r.sourceSentence || r.label}</p>
                          {r.destText && (
                            <p className="mt-0.5 line-clamp-2 font-serif text-[11px] text-muted-foreground">
                              {r.destText}
                            </p>
                          )}
                        </button>
                        <div className="mt-1 flex gap-2">
                          <button
                            className="font-mono text-[10px] text-muted-foreground underline hover:text-foreground"
                            onClick={() => props.onJumpSource(r.from)}
                          >
                            source
                          </button>
                          {r.to && (
                            <button
                              className="font-mono text-[10px] text-muted-foreground underline hover:text-foreground"
                              onClick={() => props.onJumpDest(r.to!)}
                            >
                              destination
                            </button>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          );
        })}
        {!groups.length && !props.loading && (
          <p className="font-mono text-[10px] text-muted-foreground">no references match.</p>
        )}
      </div>
      <p className="mt-3 font-mono text-[10px] text-muted-foreground">
        systems: {model.systems.length} · reading page {props.currentPage}
      </p>
    </div>
  );
}
