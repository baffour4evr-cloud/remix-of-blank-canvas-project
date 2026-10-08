import { memo, useMemo } from "react";

import { blockDiagnostics, worstTone, type BlockDiagnostic } from "@/lib/reader/diagnose";
import { toReaderBlock, type ReaderInline } from "@/lib/reader/inline";
import type { Block, RefEdge, StructureNode } from "@/lib/reader/types";

export interface BlockRenderProps {
  block: Block;
  prev: Block | undefined;
  section: StructureNode | undefined;
  order: number;
  out: RefEdge[];
  incoming: RefEdge[];
  debug: boolean;
  showDiagnostics: boolean;
  activeSystems: Set<string> | null;
  focused: boolean;
  /** when false, structural-navigation refs stay clickable but lose their highlight */
  showStructuralRefs?: boolean;
  refFocusId: string | null;
  onHover: (payload: { block: Block; diagnostics: BlockDiagnostic[]; order: number; section: StructureNode | undefined; out: RefEdge[]; incoming: RefEdge[] } | null, e?: React.MouseEvent) => void;
  onSelect: (block: Block) => void;
  onRef: (ref: RefEdge, block: Block, e: React.MouseEvent, mode: "preview" | "pin") => void;
  /** reference ids that currently have an open popup */
  openRefIds?: Set<string>;
}

const TONE_BORDER: Record<string, string> = {
  ok: "border-l-ok/40",
  warn: "border-l-warn",
  bad: "border-l-bad",
};

function BlockViewInner(props: BlockRenderProps) {
  const { block, out, incoming, debug, showDiagnostics, activeSystems, focused, refFocusId } = props;
  const diags = useMemo(
    () => blockDiagnostics(block, out, incoming, props.prev, props.section),
    [block, out, incoming, props.prev, props.section],
  );
  const tone = worstTone(diags);
  const readerBlock = useMemo(() => toReaderBlock(block, out), [block, out]);

  const content = readerBlock.inline.map((node, i) => {
    const cls = [
      node.em ? "italic" : "",
      node.strong ? "font-bold" : "",
      node.sc ? "small-caps" : "",
      node.sup ? "align-super text-[0.7em]" : "",
      node.sub ? "align-sub text-[0.7em]" : "",
      node.code ? "font-mono" : "",
    ].filter(Boolean).join(" ");
    if (!node.ref) {
      const Tag = node.code ? "code" : node.strong ? "strong" : node.em ? "em" : "span";
      return (
        <Tag key={i} className={cls || undefined} data-inline={node.type}>
          {node.text}
        </Tag>
      );
    }
    const ref = node.ref;
    const dim = activeSystems && !(ref.system && activeSystems.has(ref.system));
    const structural = ref.type === "structural-navigation" || ref.type === "page-reference";
    const plain = structural && props.showStructuralRefs === false;
    const resolved = !!(ref.to || ref.toSection);
    const open = props.openRefIds?.has(ref.id);
    return (
      <button
        key={i}
        type="button"
        data-inline={node.type}
        data-ref={ref.id}
        onClick={(e) => {
          e.stopPropagation();
          props.onRef(ref, block, e, e.detail >= 2 ? "pin" : "preview");
        }}
        className={`${cls} ${
          plain
            ? "cursor-text"
            : "rounded-sm px-0.5 underline decoration-dotted underline-offset-2"
        } ${
          plain
            ? ""
            : dim
            ? "opacity-30"
            : resolved
              ? "bg-ok/10 text-ok decoration-ok/50"
              : "bg-bad/10 text-bad decoration-bad/60"
        } ${refFocusId === ref.id || open ? "ring-1 ring-ring" : ""}`}
        title={`${ref.type} · ${ref.method} · ${Math.round(ref.confidence * 100)}% — click to preview, double-click to pin`}
      >
        {node.text}
      </button>
    );

  });

  const debugProps = debug
    ? {
        onMouseEnter: (e: React.MouseEvent) =>
          props.onHover({ block, diagnostics: diags, order: props.order, section: props.section, out, incoming }, e),
        onMouseMove: (e: React.MouseEvent) =>
          props.onHover({ block, diagnostics: diags, order: props.order, section: props.section, out, incoming }, e),
        onMouseLeave: () => props.onHover(null),
      }
    : {};

  const base = `relative scroll-mt-24 ${debug ? "hover:bg-accent/40" : ""} ${
    focused ? "bg-warn/15 ring-1 ring-warn/40" : ""
  }`;

  let body: React.ReactNode;
  if (block.type === "heading") {
    const level = block.level ?? 1;
    const size = level <= 1 ? "text-3xl" : level === 2 ? "text-2xl" : "text-xl";
    body = <h2 className={`mt-10 mb-4 font-serif ${size} font-normal tracking-tight`}>{content}</h2>;
  } else if (block.type === "verse-line") {
    body = (
      <div className="flex gap-3 pl-6 -indent-4 font-serif leading-8">
        <span className="flex-1">{content}</span>
        {block.line != null && block.line % 5 === 0 && (
          <span className="w-8 shrink-0 text-right font-mono text-[10px] text-muted-foreground">{block.line}</span>
        )}
      </div>
    );
  } else if (block.type === "verse-space") {
    body = <div className="h-5" />;
  } else if (block.type === "entry") {
    body = (
      <p className="mb-3 pl-8 -indent-8 font-serif text-[0.95rem] leading-7">
        <span className="mr-2 font-mono text-[11px] text-muted-foreground">{block.key}</span>
        {content}
      </p>
    );
  } else if (block.type === "blockquote" || block.type === "letter") {
    const edge = block.groupEdge;
    body = (
      <p
        className={`border-l-2 border-border/70 pl-5 pr-4 font-serif text-[0.98rem] leading-7 ${
          edge === "start" || edge === "only" ? "mt-5" : ""
        } ${edge === "end" || edge === "only" ? "mb-5" : ""} ${
          block.type === "letter" && (edge === "end" || edge === "only") ? "text-right" : ""
        }`}
        title={block.groupWhy}
      >
        {content}
      </p>
    );
  } else if (block.type === "list-item") {
    body = (
      <p className="mb-2 pl-8 -indent-4 font-serif text-[1.02rem] leading-7" title={block.groupWhy}>
        {content}
      </p>
    );
  } else if (block.type === "caption") {
    body = <p className="my-4 text-center font-mono text-xs text-muted-foreground">{content}</p>;
  } else {
    body = <p className="font-serif text-[1.05rem] leading-8 indent-6 first-letter:normal-case">{content}</p>;
  }

  return (
    <div
      id={`blk-${block.id}`}
      data-block={block.id}
      data-page={block.page}
      className={base}
      {...debugProps}
      onClick={() => props.onSelect(block)}
    >
      {debug && (
        <span className="pointer-events-none absolute -left-24 top-1 hidden w-20 text-right font-mono text-[10px] text-muted-foreground lg:block">
          {block.id} · p{block.page}
        </span>
      )}
      {body}
      {showDiagnostics && diags.length > 0 && (
        <ul className={`my-2 border-l-2 ${TONE_BORDER[tone ?? "ok"]} pl-3`}>
          {diags.map((d, i) => (
            <li
              key={i}
              className={`font-mono text-[10px] leading-5 ${
                d.tone === "bad" ? "text-bad" : d.tone === "warn" ? "text-warn" : "text-muted-foreground"
              }`}
            >
              {d.text}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export const BlockView = memo(BlockViewInner);
