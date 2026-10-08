import { X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { DestinationBlock, RunText } from "@/components/reader/RichText";
import type { ModelArtifact } from "@/lib/reader/artifacts";
import { useDestination } from "@/lib/reader/useDoc";
import type { Block, RefEdge } from "@/lib/reader/types";

export interface PopupRequest {
  ref: RefEdge;
  sourceBlock: Block;
  /** viewport rect of the clicked marker */
  markerRect: { top: number; bottom: number; left: number; right: number };
  /** viewport rect of the source paragraph — the popup must never cover it */
  paragraphRect: { top: number; bottom: number; left: number; right: number };
  pinned: boolean;
}

const GAP = 10;
const MIN_H = 140;

/** Choose a placement that keeps the source paragraph fully visible. */
function place(req: PopupRequest, w: number, h: number) {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const width = Math.min(w, vw - 2 * GAP);
  const para = req.paragraphRect;

  const below = vh - para.bottom - 2 * GAP;
  const above = para.top - 2 * GAP;
  const right = vw - para.right - 2 * GAP;
  const left = para.left - 2 * GAP;

  const clampX = (x: number) => Math.max(GAP, Math.min(x, vw - width - GAP));

  if (below >= Math.min(h, MIN_H)) {
    return { left: clampX(req.markerRect.left - 40), top: para.bottom + GAP, width, maxHeight: below };
  }
  if (above >= Math.min(h, MIN_H)) {
    const height = Math.min(h, above);
    return { left: clampX(req.markerRect.left - 40), top: para.top - GAP - height, width, maxHeight: above };
  }
  if (right >= 280) {
    const wid = Math.min(width, right);
    return {
      left: para.right + GAP,
      top: Math.max(GAP, Math.min(req.markerRect.top - 24, vh - Math.min(h, vh - 2 * GAP) - GAP)),
      width: wid,
      maxHeight: vh - 2 * GAP,
    };
  }
  if (left >= 280) {
    const wid = Math.min(width, left);
    return {
      left: Math.max(GAP, para.left - GAP - wid),
      top: Math.max(GAP, Math.min(req.markerRect.top - 24, vh - Math.min(h, vh - 2 * GAP) - GAP)),
      width: wid,
      maxHeight: vh - 2 * GAP,
    };
  }
  // nowhere clear: dock to the bottom edge, still below the marker line
  return { left: clampX(GAP), top: vh - Math.min(h, vh / 2) - GAP, width, maxHeight: vh / 2 };
}

export interface RefPopupProps {
  docId: string;
  model: ModelArtifact;
  req: PopupRequest;
  offset?: number;
  fontScale: number;
  onClose: () => void;
  onPin: () => void;
  onGoToDestination: () => void;
  onOpenInSidebar: () => void;
}

export function RefPopup(props: RefPopupProps) {
  const { req, model } = props;
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; width: number; maxHeight: number } | null>(null);
  const dest = useDestination(props.docId, model, req.ref.to);

  useLayoutEffect(() => {
    const h = box.current?.offsetHeight ?? 320;
    setPos(place(req, 460, h));
  }, [req, dest.blocks.length]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && props.onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [props]);

  const sys = model.systems.find((s) => s.id === req.ref.system);
  const resolved = !!req.ref.to;
  const off = (props.offset ?? 0) * 14;

  return (
    <div
      ref={box}
      role="dialog"
      className="fixed z-40 flex flex-col overflow-hidden rounded-md border border-border bg-popover shadow-xl"
      style={{
        left: (pos?.left ?? -9999) + off,
        top: (pos?.top ?? -9999) + off,
        width: pos?.width ?? 460,
        maxHeight: pos?.maxHeight ?? 400,
        visibility: pos ? "visible" : "hidden",
      }}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      <header className="flex items-center gap-2 border-b border-border px-3 py-2">
        <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
          {sys?.label ?? req.ref.type.replace("-", " ")}
        </span>
        <span className="font-mono text-[10px] text-muted-foreground">
          {req.ref.key} · {req.ref.method} · {Math.round(req.ref.confidence * 100)}%
        </span>
        {req.pinned && <span className="font-mono text-[10px] text-warn">pinned</span>}
        <div className="ml-auto flex items-center gap-2">
          {!req.pinned && (
            <button onClick={props.onPin} className="font-mono text-[10px] text-muted-foreground hover:text-foreground">
              pin
            </button>
          )}
          <button onClick={props.onClose} className="text-muted-foreground hover:text-foreground" aria-label="close">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-auto px-3 py-3" style={{ fontSize: `${props.fontScale}rem` }}>
        <p className="mb-1 font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
          {req.ref.type.replace(/-/g, " ")} · {req.ref.provenance === "explicit-link" ? "linked" : "inferred"} · source p
          {model.blockPage[req.sourceBlock.id] ?? req.sourceBlock.page}
          {(() => {
            const sec = model.structure.find((n) => n.id === req.sourceBlock.section);
            return sec && sec.type !== "root" ? ` · ${sec.label}` : "";
          })()}
        </p>
        <p className="mb-2 font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
          {sys
            ? `note system · ${sys.label} · ${sys.kind.replace(/-/g, " ")} · ${sys.grammar.replace(/-/g, " ")} markers`
            : "note system · none identified"}
        </p>
        <p className="mb-1 font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">source sentence</p>
        <p className="mb-3 border-l-2 border-border pl-2 font-serif leading-7 text-muted-foreground">
          <RunText
            block={req.sourceBlock}
            start={req.ref.sentence.start}
            end={req.ref.sentence.end}
            markStart={req.ref.marker.start}
            markEnd={req.ref.marker.end}
          />
        </p>

        <p className="mb-1 font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
          {resolved
            ? `destination · ${
                req.ref.toSection
                  ? `${model.structure.find((n) => n.id === req.ref.toSection)?.label ?? "section"} · `
                  : ""
              }p${(req.ref.to && model.blockPage[req.ref.to]) ?? "?"}`
            : req.ref.ambiguous
              ? "ambiguous — several destinations"
              : "unresolved"}
        </p>
        {resolved ? (
          dest.loading && !dest.blocks.length ? (
            <p className="font-mono text-[11px] text-muted-foreground">loading node…</p>
          ) : (
            <div className="font-serif">
              {dest.blocks.map((b) => (
                <DestinationBlock key={b.id} block={b} />
              ))}
            </div>
          )
        ) : (
          <p className="font-mono text-[11px] text-bad">
            {req.ref.note ??
              model.diagnostics.unresolved.find((u) => u.from === req.ref.from)?.reason ??
              "no destination resolved"}
          </p>
        )}

        {req.ref.evidence.length > 0 && (
          <details className="mt-3">
            <summary className="cursor-pointer font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
              parser evidence
            </summary>
            <ul className="mt-1">
              {req.ref.evidence.map((e, i) => (
                <li key={i} className="font-mono text-[10px] leading-4 text-muted-foreground">
                  · {e}
                </li>
              ))}
            </ul>
            {req.ref.candidates?.length ? (
              <ul className="mt-1">
                {req.ref.candidates.map((c, i) => (
                  <li key={i} className="font-mono text-[10px] leading-4 text-warn">
                    candidate {c.to} · {c.key} · score {c.score} — {c.why}
                  </li>
                ))}
              </ul>
            ) : null}
          </details>
        )}
      </div>

      <footer className="flex items-center gap-2 border-t border-border px-3 py-2">
        <button
          disabled={!resolved}
          onClick={props.onGoToDestination}
          className="rounded border border-border px-2 py-1 font-mono text-[10px] disabled:opacity-40"
        >
          go to reference
        </button>
        <button
          onClick={props.onOpenInSidebar}
          className="rounded border border-border px-2 py-1 font-mono text-[10px]"
        >
          open in sidebar
        </button>
        <span className="ml-auto font-mono text-[10px] text-muted-foreground">
          p{model.blockPage[req.ref.from] ?? "?"} → p{req.ref.to ? model.blockPage[req.ref.to] ?? "?" : "—"}
        </span>
      </footer>
    </div>
  );
}
