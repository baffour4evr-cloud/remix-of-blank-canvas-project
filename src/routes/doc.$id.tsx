import { Link, createFileRoute } from "@tanstack/react-router";
import { useState } from "react";

import { PageView } from "@/components/inspector/PageView";
import { RefsView } from "@/components/inspector/RefsView";
import { OutlineView, SystemsView } from "@/components/inspector/SystemsView";
import { useModel } from "@/lib/reader/useDoc";

export const Route = createFileRoute("/doc/$id")({
  head: () => ({
    meta: [
      { title: "Import inspector — Apparatus" },
      {
        name: "description",
        content:
          "Inspect extracted line clusters, outline blocks, apparatus systems and reference resolution paths for an imported PDF.",
      },
      { property: "og:title", content: "Import inspector — Apparatus" },
      {
        property: "og:description",
        content: "Line clusters, blocks, apparatus systems and reference traces for an imported PDF.",
      },
    ],
  }),
  component: Inspector,
  errorComponent: ({ error }) => (
    <p role="alert" className="p-10 text-sm text-bad">
      {error instanceof Error ? error.message : String(error)}
    </p>
  ),
  notFoundComponent: () => <p className="p-10 text-sm">Document not found.</p>,
});

const TABS = ["structure", "systems", "pages", "references"] as const;

function Inspector() {
  const { id } = Route.useParams();
  const [tab, setTab] = useState<(typeof TABS)[number]>("systems");
  const model = useModel(id);

  return (
    <main className="mx-auto min-h-screen max-w-7xl px-6 pb-24 pt-10">
      <Link to="/" className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground hover:text-foreground">
        ← library
      </Link>
      <Link
        to="/read/$id"
        params={{ id }}
        className="ml-4 font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground hover:text-foreground"
      >
        validation reader →
      </Link>

      {model.isLoading && <p className="mt-10 text-sm text-muted-foreground">Loading artifacts…</p>}
      {model.error && <p className="mt-10 text-sm text-bad">{(model.error as Error).message}</p>}

      {model.data && (
        <>
          <header className="mt-4 border-b border-border pb-6">
            <h1 className="font-serif text-4xl font-light tracking-tight">{model.data.title}</h1>
            <p className="mt-2 flex flex-wrap gap-x-5 font-mono text-[11px] text-muted-foreground">
              <span>{model.data.author ?? "unknown author"}</span>
              <span>{model.data.pageCount} pages</span>
              <span>{model.data.structure.length - 1} sections</span>
              <span>{model.data.systems.length} systems</span>
              <span>{model.data.refs.length} references</span>
              <span className="text-ok">
                {model.data.refs.filter((r) => r.to || r.toSection).length} resolved
              </span>
            </p>
          </header>

          <nav className="mt-6 flex gap-6 border-b border-border">
            {TABS.map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`-mb-px border-b-2 pb-3 font-mono text-[11px] uppercase tracking-[0.18em] transition-colors ${
                  tab === t
                    ? "border-foreground text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground"
                }`}
              >
                {t}
              </button>
            ))}
          </nav>

          <div className="mt-8">
            {tab === "structure" && <OutlineView model={model.data} />}
            {tab === "systems" && <SystemsView model={model.data} />}
            {tab === "pages" && <PageView id={id} model={model.data} />}
            {tab === "references" && <RefsView id={id} model={model.data} />}
          </div>
        </>
      )}
    </main>
  );
}
