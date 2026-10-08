import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useState } from "react";

import { getSourceUrl } from "@/lib/import.functions";

/** Reference-only view of the original PDF, kept roughly in sync by page. */
export function PdfPane({
  id,
  page,
  pageCount,
  onPickPage,
}: {
  id: string;
  page: number;
  pageCount: number;
  onPickPage: (page: number) => void;
}) {
  const fn = useServerFn(getSourceUrl);
  const src = useQuery({
    queryKey: ["source", id],
    queryFn: () => fn({ data: { id } }) as Promise<{ url: string | null }>,
    staleTime: 1000 * 60 * 60,
  });
  const [input, setInput] = useState(String(page));
  useEffect(() => setInput(String(page)), [page]);

  const url = src.data?.url;

  return (
    <div className="flex h-full flex-col bg-muted/40">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <span className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground">original pdf</span>
        <div className="ml-auto flex items-center gap-1">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                const n = Number(input);
                if (Number.isFinite(n) && n >= 1 && n <= pageCount) onPickPage(n);
              }
            }}
            className="w-14 rounded border border-input bg-background px-2 py-1 text-center font-mono text-xs"
            aria-label="PDF page"
          />
          <span className="font-mono text-[11px] text-muted-foreground">/ {pageCount}</span>
          <button
            className="rounded border border-border px-2 py-1 font-mono text-[10px] text-muted-foreground hover:text-foreground"
            onClick={() => {
              const n = Number(input);
              if (Number.isFinite(n)) onPickPage(n);
            }}
            title="Scroll the normalized document to the first block on this PDF page"
          >
            sync reader →
          </button>
        </div>
      </div>
      <div className="min-h-0 flex-1">
        {src.isLoading && <p className="p-4 font-mono text-xs text-muted-foreground">loading source…</p>}
        {!src.isLoading && !url && (
          <p className="p-4 font-mono text-xs text-muted-foreground">
            no original file stored for this import — the normalized document is still fully inspectable.
          </p>
        )}
        {url && (
          <iframe
            key={page}
            title="Original PDF"
            src={`${url}#page=${page}&view=FitH`}
            className="h-full w-full border-0"
          />
        )}
      </div>
    </div>
  );
}
