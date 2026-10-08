import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useCallback, useEffect, useMemo, useState } from "react";

import { getChunk, getModel, getRefIndex, type RefIndexEntry } from "@/lib/import.functions";
import { isProse } from "@/lib/reader/types";
import { chunkOfPage, type ChunkArtifact, type ModelArtifact } from "@/lib/reader/artifacts";
import type { Block } from "@/lib/reader/types";

export function useModel(id: string) {
  const fn = useServerFn(getModel);
  return useQuery({
    queryKey: ["model", id],
    queryFn: () => fn({ data: { id } }) as Promise<ModelArtifact | null>,
    staleTime: Infinity,
    retry: false,
  });
}

export function useChunk(id: string, index: number | null) {
  const fn = useServerFn(getChunk);
  return useQuery({
    queryKey: ["chunk", id, index],
    queryFn: () => fn({ data: { id, index: index as number } }) as Promise<ChunkArtifact>,
    enabled: index != null && index >= 0,
    staleTime: Infinity,
  });
}

/** Flattened reference index (source sentence + destination text per edge). */
export function useRefTable(id: string, enabled = true) {
  const fn = useServerFn(getRefIndex);
  return useQuery({
    queryKey: ["refindex", id],
    queryFn: () => fn({ data: { id } }) as Promise<RefIndexEntry[]>,
    staleTime: Infinity,
    retry: false,
    enabled,
  });
}

/** Loads (and caches) whichever chunk holds a given block, then returns it. */
export function useBlockResolver(id: string, model: ModelArtifact | undefined) {
  const qc = useQueryClient();
  const fn = useServerFn(getChunk);

  return useCallback(
    async (blockId: string): Promise<Block | null> => {
      if (!model) return null;
      const page = model.blockPage[blockId];
      if (page == null) return null;
      const index = chunkOfPage(page, model.chunkPages);
      const chunk = await qc.fetchQuery({
        queryKey: ["chunk", id, index],
        queryFn: () => fn({ data: { id, index } }) as Promise<ChunkArtifact>,
        staleTime: Infinity,
      });
      return chunk.blocks.find((b) => b.id === blockId) ?? null;
    },
    [qc, fn, id, model],
  );
}

/**
 * A destination node together with its continuation nodes, so a note that runs
 * over several paragraphs is previewed whole rather than cut at the node edge.
 */
export function useDestination(id: string, model: ModelArtifact | undefined, blockId: string | null) {
  const qc = useQueryClient();
  const fn = useServerFn(getChunk);
  const [state, setState] = useState<{ blocks: Block[]; loading: boolean }>({ blocks: [], loading: false });

  useEffect(() => {
    let cancelled = false;
    if (!blockId || !model) {
      setState({ blocks: [], loading: false });
      return;
    }
    const page = model.blockPage[blockId];
    if (page == null) {
      setState({ blocks: [], loading: false });
      return;
    }
    setState((s) => ({ blocks: s.blocks, loading: true }));
    const index = chunkOfPage(page, model.chunkPages);
    void qc
      .fetchQuery({
        queryKey: ["chunk", id, index],
        queryFn: () => fn({ data: { id, index } }) as Promise<ChunkArtifact>,
        staleTime: Infinity,
      })
      .then((chunk: ChunkArtifact) => {
        if (cancelled) return;
        const i = chunk.blocks.findIndex((b) => b.id === blockId);
        if (i < 0) return setState({ blocks: [], loading: false });
        const head = chunk.blocks[i]!;
        const out = [head];
        for (let j = i + 1; j < chunk.blocks.length; j++) {
          const b = chunk.blocks[j]!;
          if (b.section !== head.section) break;
          if (b.type === "heading" || b.type === "entry" || b.key) break;
          if (head.type !== "entry" && !isProse(head.type)) break;
          if (!isProse(b.type)) break;
          out.push(b);
        }
        setState({ blocks: out, loading: false });
      });
    return () => {
      cancelled = true;
    };
  }, [id, blockId, model, qc, fn]);

  return state;
}


export interface NavTarget {
  refId: string;
  /** which end of the edge we are standing on */
  side: "source" | "target";
}

/** Back-and-forth navigation across reference edges, with real history. */
export function useRefNav() {
  const [stack, setStack] = useState<NavTarget[]>([]);
  const [i, setI] = useState(-1);

  const go = useCallback(
    (t: NavTarget) => {
      setStack((prev) => {
        const next = [...prev.slice(0, i + 1), t];
        setI(next.length - 1);
        return next;
      });
    },
    [i],
  );

  return {
    current: i >= 0 ? stack[i] ?? null : null,
    stack,
    index: i,
    go,
    back: () => setI((v) => Math.max(0, v - 1)),
    forward: () => setI((v) => Math.min(stack.length - 1, v + 1)),
    canBack: i > 0,
    canForward: i >= 0 && i < stack.length - 1,
    flip: () =>
      setStack((prev) => {
        if (i < 0) return prev;
        const cur = prev[i]!;
        const next = [...prev.slice(0, i + 1), { ...cur, side: cur.side === "source" ? ("target" as const) : ("source" as const) }];
        setI(next.length - 1);
        return next;
      }),
    reset: () => {
      setStack([]);
      setI(-1);
    },
  };
}

export function useRefIndex(model: ModelArtifact | undefined) {
  return useMemo(() => {
    const byId = new Map<string, (typeof refs)[number]>();
    const refs = model?.refs ?? [];
    const outgoing = new Map<string, string[]>();
    const incoming = new Map<string, string[]>();
    for (const r of refs) {
      byId.set(r.id, r);
      outgoing.set(r.from, [...(outgoing.get(r.from) ?? []), r.id]);
      if (r.to) incoming.set(r.to, [...(incoming.get(r.to) ?? []), r.id]);
    }
    return { byId, outgoing, incoming, refs };
  }, [model]);
}
