import type { Block } from "@/lib/reader/types";
import { toReaderBlock } from "@/lib/reader/inline";

/**
 * Renders a character range of a normalized block, preserving the run-level
 * formatting (italics, superscripts) the parser recorded. Never truncates:
 * callers pass semantic ranges produced by the parser, not display limits.
 */
export function RunText({
  block,
  start = 0,
  end,
  markStart,
  markEnd,
}: {
  block: Block;
  start?: number;
  end?: number;
  /** optional inner range to visually mark (e.g. the reference marker) */
  markStart?: number;
  markEnd?: number;
}) {
  const stop = end ?? block.text.length;
  const out: React.ReactNode[] = [];
  let k = 0;
  for (const node of toReaderBlock(block).inline) {
    const from = Math.max(start, node.range.start);
    const to = Math.min(stop, node.range.end);
    if (to <= from) continue;
    const bounds = [from, to];
    if (markStart != null && markStart > from && markStart < to) bounds.push(markStart);
    if (markEnd != null && markEnd > from && markEnd < to) bounds.push(markEnd);
    const cuts = [...new Set(bounds)].sort((a, b) => a - b);
    for (let i = 0; i < cuts.length - 1; i++) {
      const a = cuts[i] ?? from;
      const b = cuts[i + 1] ?? to;
      const text = block.text.slice(a, b);
      const marked = markStart != null && markEnd != null && a >= markStart && b <= markEnd;
      const cls = [
        node.em ? "italic" : "",
        node.strong ? "font-bold" : "",
        node.sc ? "small-caps" : "",
        node.sup ? "align-super text-[0.7em]" : "",
        node.sub ? "align-sub text-[0.7em]" : "",
        node.code ? "font-mono" : "",
        marked ? "rounded-sm bg-warn/25 px-0.5" : "",
      ].filter(Boolean).join(" ");
      const Tag = node.code ? "code" : node.strong ? "strong" : node.em ? "em" : "span";
      out.push(<Tag key={k++} className={cls || undefined}>{text}</Tag>);
    }
  }
  return <>{out}</>;
}

/** Renders a whole destination node with its structural shape intact. */
export function DestinationBlock({ block }: { block: Block }) {
  if (block.type === "heading") {
    return (
      <h3 className="mt-1 mb-2 font-serif text-lg leading-snug">
        <RunText block={block} />
      </h3>
    );
  }
  if (block.type === "verse-line") {
    return (
      <div className="pl-5 -indent-4 font-serif leading-7">
        <RunText block={block} />
        {block.line != null && (
          <span className="ml-2 font-mono text-[10px] text-muted-foreground">{block.line}</span>
        )}
      </div>
    );
  }
  if (block.type === "verse-space") return <div className="h-3" />;
  if (block.type === "entry") {
    return (
      <p className="mb-3 pl-6 -indent-6 font-serif leading-7">
        {block.key && <span className="mr-2 font-mono text-[11px] text-muted-foreground">{block.key}</span>}
        <RunText block={block} />
      </p>
    );
  }
  if (block.type === "caption") {
    return (
      <p className="my-2 text-center font-mono text-xs text-muted-foreground">
        <RunText block={block} />
      </p>
    );
  }
  if (block.type === "blockquote" || block.type === "letter") {
    return (
      <p className="mb-3 border-l-2 border-border pl-4 font-serif text-[0.95em] leading-7">
        <RunText block={block} />
      </p>
    );
  }
  if (block.type === "list-item") {
    return (
      <p className="mb-2 pl-6 -indent-4 font-serif leading-7">
        <RunText block={block} />
      </p>
    );
  }
  return (
    <p className="mb-3 font-serif leading-7">
      <RunText block={block} />
    </p>
  );
}
