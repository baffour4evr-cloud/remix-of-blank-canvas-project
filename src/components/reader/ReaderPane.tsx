import { useQueries } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { BlockView } from "@/components/reader/BlockView";
import { getChunk } from "@/lib/import.functions";
import { chunkOfPage, type ChunkArtifact, type ModelArtifact } from "@/lib/reader/artifacts";
import type { BlockDiagnostic } from "@/lib/reader/diagnose";
import type { Block, RefEdge, StructureNode } from "@/lib/reader/types";

export interface HoverPayload {
  block: Block;
  diagnostics: BlockDiagnostic[];
  order: number;
  section: StructureNode | undefined;
  out: RefEdge[];
  incoming: RefEdge[];
}

export interface ReaderPaneProps {
  id: string;
  model: ModelArtifact;
  debug: boolean;
  showDiagnostics: boolean;
  activeSystems: Set<string> | null;
  /** when false, structural-navigation edges render unstyled but stay clickable */
  showStructuralRefs?: boolean;
  /** block to scroll to; bump `nonce` to re-trigger the same target.
   *  `top` restores an exact previous scroll offset (used by "go back"). */
  target: { blockId: string; nonce: number; top?: number } | null;
  focusBlockId: string | null;
  refFocusId: string | null;
  openRefIds?: Set<string>;
  outgoing: Map<string, string[]>;
  incoming: Map<string, string[]>;
  refById: Map<string, RefEdge>;
  /** the pane's scroll container, so callers can record reading positions */
  scrollRef?: React.RefObject<HTMLDivElement | null>;
  onSelectBlock: (block: Block) => void;
  onRef: (ref: RefEdge, block: Block, e: React.MouseEvent, mode: "preview" | "pin") => void;
  onVisiblePage: (page: number) => void;
}


/** how many chunks on either side of the viewport stay mounted in the DOM */
const WINDOW = 1;
/** first guess at a chunk's rendered height, replaced by a real measurement */
const EST_HEIGHT = 12000;

/**
 * Continuous, chunk-virtualized reader.
 *
 * The whole document exists as one scrollable column — there are no "load more"
 * boundaries — but only the chunks near the viewport are mounted. Chunks that
 * scroll away are replaced by a spacer of their last measured height, so the
 * scrollbar never jumps and a jump to any node is a single scroll, not a
 * sequence of loads.
 */
export function ReaderPane(props: ReaderPaneProps) {
  const { id, model } = props;
  const fn = useServerFn(getChunk);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const chunkRefs = useRef<(HTMLDivElement | null)[]>([]);
  const heights = useRef<number[]>([]);
  const pending = useRef<string | null>(null);
  const [center, setCenter] = useState(0);

  const first = Math.max(0, center - WINDOW);
  const last = Math.min(model.chunkCount - 1, center + WINDOW);
  const live = useMemo(
    () => Array.from({ length: last - first + 1 }, (_, i) => first + i),
    [first, last],
  );

  const results = useQueries({
    queries: live.map((index) => ({
      queryKey: ["chunk", id, index],
      queryFn: () => fn({ data: { id, index } }) as Promise<ChunkArtifact>,
      staleTime: Infinity,
      gcTime: 30 * 60 * 1000,
    })),
  });

  const chunkData = useMemo(() => {
    const map = new Map<number, ChunkArtifact>();
    results.forEach((r) => {
      if (r.data) map.set(r.data.index, r.data);
    });
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [results.map((r) => (r.data ? r.data.index : -1)).join(",")]);

  const sections = useMemo(() => new Map(model.structure.map((s) => [s.id, s])), [model.structure]);

  const measure = useCallback((index: number) => {
    const el = chunkRefs.current[index];
    if (el && el.offsetHeight > 0) heights.current[index] = el.offsetHeight;
  }, []);

  // --- which chunk is in view ------------------------------------------------
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    let raf = 0;
    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const top = el.getBoundingClientRect().top;
        let visible = center;
        for (let i = 0; i < model.chunkCount; i++) {
          const node = chunkRefs.current[i];
          if (!node) continue;
          const r = node.getBoundingClientRect();
          if (r.bottom > top + 40) {
            visible = i;
            break;
          }
        }
        if (visible !== center) {
          measure(center);
          setCenter(visible);
        }
        const pageNodes = el.querySelectorAll<HTMLElement>("[data-page]");
        for (const n of pageNodes) {
          if (n.getBoundingClientRect().bottom >= top + 80) {
            props.onVisiblePage(Number(n.dataset["page"]));
            break;
          }
        }
      });
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(raf);
    };
  }, [center, measure, model.chunkCount, props]);

  // --- jump handling ---------------------------------------------------------
  useEffect(() => {
    if (!props.target) return;
    if (props.target.top != null) {
      scrollerRef.current?.scrollTo({ top: props.target.top });
      pending.current = null;
      return;
    }
    const blockId = props.target.blockId;
    const page = model.blockPage[blockId];
    if (page == null) return;
    const ci = chunkOfPage(page, model.chunkPages);
    pending.current = blockId;
    const el = document.getElementById(`blk-${blockId}`);
    if (el) {
      el.scrollIntoView({ block: "center" });
      pending.current = null;
      return;
    }

    // scroll to the chunk's placeholder first so the jump feels immediate,
    // then refine onto the node once its chunk has rendered
    chunkRefs.current[ci]?.scrollIntoView({ block: "start" });
    setCenter(ci);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.target?.blockId, props.target?.nonce]);

  useEffect(() => {
    if (!pending.current) return;
    const el = document.getElementById(`blk-${pending.current}`);
    if (el) {
      el.scrollIntoView({ block: "center" });
      pending.current = null;
    }
  }, [chunkData]);

  const [hover, setHover] = useState<{ p: HoverPayload; x: number; y: number } | null>(null);

  return (
    <div
      ref={(el) => {
        scrollerRef.current = el;
        if (props.scrollRef) props.scrollRef.current = el;
      }}
      className="relative h-full overflow-auto bg-background"
    >
      <article className="mx-auto max-w-[38rem] px-6 py-10 lg:pl-28">
        {Array.from({ length: model.chunkCount }, (_, ci) => {
          const data = chunkData.get(ci);
          const mounted = ci >= first && ci <= last;
          return (
            <div
              key={ci}
              data-chunk={ci}
              ref={(el) => {
                chunkRefs.current[ci] = el;
              }}
              style={mounted && data ? undefined : { height: heights.current[ci] ?? EST_HEIGHT }}
            >
              {mounted && data ? (
                <ChunkBlocks
                  blocks={data.blocks}
                  model={model}
                  sections={sections}
                  props={props}
                  onHover={setHover}
                />
              ) : null}
            </div>
          );
        })}
      </article>

      {props.debug && hover && <DebugTooltip {...hover} model={model} />}
    </div>
  );
}

function ChunkBlocks({
  blocks,
  model,
  sections,
  props,
  onHover,
}: {
  blocks: Block[];
  model: ModelArtifact;
  sections: Map<string, StructureNode>;
  props: ReaderPaneProps;
  onHover: (h: { p: HoverPayload; x: number; y: number } | null) => void;
}) {
  return (
    <>
      {blocks.map((b, i) => {
        const out = (props.outgoing.get(b.id) ?? []).map((r) => props.refById.get(r)!).filter(Boolean);
        const inc = (props.incoming.get(b.id) ?? []).map((r) => props.refById.get(r)!).filter(Boolean);
        return (
          <BlockView
            key={b.id}
            block={b}
            prev={blocks[i - 1]}
            section={sections.get(b.section)}
            order={model.blockOrder[b.id] ?? i}
            out={out}
            incoming={inc}
            debug={props.debug}
            showDiagnostics={props.showDiagnostics}
            activeSystems={props.activeSystems}
            showStructuralRefs={props.showStructuralRefs !== false}
            focused={props.focusBlockId === b.id}
            refFocusId={props.refFocusId}
            {...(props.openRefIds ? { openRefIds: props.openRefIds } : {})}

            onHover={(p, e) => onHover(p && e ? { p, x: e.clientX, y: e.clientY } : null)}
            onSelect={props.onSelectBlock}
            onRef={props.onRef}
          />
        );
      })}
    </>
  );
}

function DebugTooltip({ p, x, y, model }: { p: HoverPayload; x: number; y: number; model: ModelArtifact }) {
  const rows: [string, string][] = [
    ["node id", p.block.id],
    ["node type", p.block.type + (p.block.level ? ` (level ${p.block.level})` : "")],
    ["section", p.section ? `${p.section.type} · ${p.section.label}` : p.block.section],
    ["source page", String(p.block.page)],
    ["source pages", p.block.prov ? p.block.prov.pages.join(", ") : String(p.block.page)],
    ["source lines", p.block.prov ? String(p.block.prov.lines) : "—"],
    ["reading order", `${p.order} / ${Object.keys(model.blockOrder).length}`],
    ["verse line", p.block.line != null ? String(p.block.line) : "—"],
    ["entry key", p.block.key ?? "—"],
    ["lemma", p.block.lemma ?? "—"],
    [
      "editorial system",
      p.block.system
        ? model.systems.find((s) => s.id === p.block.system)?.label ?? p.block.system
        : [...new Set(p.out.map((r) => r.system).filter(Boolean))]
            .map((s) => model.systems.find((x) => x.id === s)?.label ?? s)
            .join(", ") || "—",
    ],
    [
      "confidence",
      p.out.length
        ? `refs ${Math.round(Math.min(...p.out.map((r) => r.confidence)) * 100)}–${Math.round(
            Math.max(...p.out.map((r) => r.confidence)) * 100,
          )}%`
        : "—",
    ],
    ["references out", p.out.length ? p.out.map((r) => `${r.label} → ${r.to ?? r.toSection ?? "unresolved"}`).join(" · ") : "none"],
    ["references in", p.incoming.length ? p.incoming.map((r) => `${r.from} (${r.label})`).join(" · ") : "none"],
  ];
  const left = Math.min(x + 16, (typeof window !== "undefined" ? window.innerWidth : 1200) - 400);
  const top = Math.min(y + 16, (typeof window !== "undefined" ? window.innerHeight : 800) - 380);
  return (
    <div
      className="pointer-events-none fixed z-50 w-[24rem] rounded-md border border-border bg-popover p-3 shadow-lg"
      style={{ left, top }}
    >
      <dl className="grid grid-cols-[8rem_minmax(0,1fr)] gap-x-3 gap-y-1 font-mono text-[10px] leading-4">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-muted-foreground">{k}</dt>
            <dd className="break-words text-foreground">{v}</dd>
          </div>
        ))}
      </dl>
      {p.diagnostics.length > 0 && (
        <ul className="mt-2 border-t border-border pt-2">
          {p.diagnostics.map((d, i) => (
            <li
              key={i}
              className={`font-mono text-[10px] leading-4 ${
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
