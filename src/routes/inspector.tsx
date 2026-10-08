import { useQuery } from "@tanstack/react-query";
import { Link, createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";

import { listDocuments } from "@/lib/import.functions";

export const Route = createFileRoute("/inspector")({
  head: () => ({
    meta: [
      { title: "Inspector — Apparatus developer tools" },
      {
        name: "description",
        content:
          "Permanent developer tool: open any imported document's semantic model, apparatus systems and reference graph.",
      },
      { property: "og:title", content: "Inspector — Apparatus developer tools" },
      { property: "og:description", content: "Open any import's semantic model, systems and reference graph." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: InspectorIndex,
});

function InspectorIndex() {
  const list = useServerFn(listDocuments);
  const docs = useQuery({ queryKey: ["documents"], queryFn: () => list({}) });

  return (
    <main className="mx-auto min-h-screen max-w-3xl px-6 py-16">
      <Link to="/" className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground hover:text-foreground">
        ← library
      </Link>
      <h1 className="mt-4 font-serif text-4xl font-light tracking-tight">Inspector</h1>
      <p className="mt-3 max-w-xl text-sm text-muted-foreground">
        Permanent developer tool. Pick an import to inspect its structure tree, editorial systems, page geometry and
        reference graph without re-running extraction.
      </p>
      <ul className="mt-10 divide-y divide-border border-y border-border">
        {docs.data?.map((d) => (
          <li key={d.id} className="flex items-center gap-4 py-4">
            <span className="min-w-0 flex-1 truncate font-serif text-lg">{d.title}</span>
            <Link to="/doc/$id" params={{ id: d.id }} className="font-mono text-[11px] underline">
              inspect
            </Link>
            <Link to="/read/$id" params={{ id: d.id }} className="font-mono text-[11px] underline">
              read
            </Link>
          </li>
        ))}
      </ul>
    </main>
  );
}
