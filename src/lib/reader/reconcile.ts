// Reference recognition and reconciliation.
//
// Every detector (explicit links, inline markers, line keys, lemmas, textual
// references, citations) only *proposes* candidates. Each candidate carries
// the signals that made it a candidate. This module then decides, separately:
//
//   1. recognition  — is this text functioning as a reference at all?
//                     (combined recognition signals, never one regex)
//   2. resolution   — is the proposed destination valid for its system?
//   3. range        — exact inline offsets, never widened
//   4. system/type  — the system owning the validated destination
//
// and reconciles competing candidates over the same characters. The final
// reader reference model is the output of this pass. Every decision, including
// every rejection, is recorded for diagnostics.

import type { ApparatusEntry } from "./apparatus";
import { markerKey } from "./markers";
import type { Block, RefEdge, RefSystem, StructureNode } from "./types";

/** Evidence that a piece of text is *functioning* as a reference. */
export type SignalKind =
  | "explicit-link"
  | "superscript"
  | "bracketed"
  | "parenthesized"
  | "glued-symbol"
  | "system-key"
  | "sequence"
  | "cue"
  | "cued-list"
  | "intrinsic-form"
  | "named-node-exists"
  | "capitalized-label"
  | "lemma"
  | "line-key"
  | "author-date"
  // negative evidence
  | "math-context"
  | "isolated-typography"
  | "vocabulary-only";

export interface Signal {
  kind: SignalKind;
  note?: string;
}

/** Weight of each signal for recognition; negative values are penalties. */
export const SIGNAL_WEIGHT: Record<SignalKind, number> = {
  "explicit-link": 0.99,
  superscript: 0.7,
  bracketed: 0.6,
  parenthesized: 0.25,
  "glued-symbol": 0.3,
  "system-key": 0.5,
  sequence: 0.2,
  cue: 0.6,
  "cued-list": 0.5,
  "intrinsic-form": 0.45,
  "named-node-exists": 0.35,
  "capitalized-label": 0.15,
  lemma: 0.75,
  "line-key": 0.8,
  "author-date": 0.5,
  "math-context": -0.7,
  "isolated-typography": -0.4,
  "vocabulary-only": -0.5,
};

/** A recognised reference must reach this when its destination is validated. */
export const ACCEPT_RESOLVED = 0.4;
/** Without a destination, only strong recognition keeps a visible candidate. */
export const KEEP_UNRESOLVED = 0.6;

export function recognitionScore(signals: Signal[]): number {
  let miss = 1;
  let penalty = 0;
  for (const s of signals) {
    const w = SIGNAL_WEIGHT[s.kind];
    if (w >= 0) miss *= 1 - w;
    else penalty = Math.max(penalty, -w);
  }
  return Math.round((1 - miss) * (1 - penalty) * 1000) / 1000;
}

export type Decision = "accepted" | "accepted-unresolved" | "merged" | "rejected";

/** One row of the recognition log: every candidate, kept or not. */
export interface RecognitionRecord {
  id: string;
  blockId: string;
  start: number;
  end: number;
  text: string;
  method: RefEdge["method"];
  type: RefEdge["type"];
  system: string | null;
  signals: string[];
  recognition: number;
  destination: string | null;
  destinationConfidence: number;
  alternatives: { to: string; score: number; why: string }[];
  decision: Decision;
  reason: string;
}

/** Edge as proposed by a detector, before reconciliation. */
export type Proposed = RefEdge & { signals: Signal[]; exact: boolean };

export interface ReconcileContext {
  blocks: Block[];
  structure: StructureNode[];
  systems: RefSystem[];
  entries: ApparatusEntry[];
}

const NOTE_TYPES = new Set([
  "note",
  "footnote",
  "endnote",
  "editorial-note",
  "translator-note",
  "author-note",
  "commentary",
  "glossary",
]);

/**
 * Is the destination plausible for the reference's system? Returns a
 * destination confidence in [0,1] (0 = invalid) and the reason.
 */
function validate(
  c: Proposed,
  blockById: Map<string, Block>,
  sectionIds: Set<string>,
  systemIds: Set<string>,
): { conf: number; why: string } {
  if (c.link?.url) return { conf: 0.99, why: "external destination named by the file's own link" };
  if (!c.to && !c.toSection) return { conf: 0, why: "no destination proposed" };
  if (c.to && !blockById.has(c.to)) return { conf: 0, why: `destination ${c.to} does not exist` };
  if (c.toSection && !sectionIds.has(c.toSection)) return { conf: 0, why: `section ${c.toSection} does not exist` };
  const dest = c.to ? blockById.get(c.to)! : null;
  const link = c.provenance === "explicit-link";
  const base = Math.min(1, c.ambiguous ? 0.5 : c.confidence);

  if (c.method === "marker") {
    // a marker resolves only to an entry of a known system carrying its identity
    if (!dest || dest.type !== "entry") return { conf: 0, why: "marker destination is not a note entry" };
    if (c.system && !systemIds.has(c.system)) return { conf: 0, why: "destination system is unknown" };
    if (markerKey(dest.key ?? "") !== markerKey(String(c.key ?? ""))) {
      return { conf: 0, why: `entry is keyed "${dest.key}", marker is "${c.key}"` };
    }
    return { conf: base, why: "entry of the marker's system carries the same key" };
  }
  if (link) {
    // the file names the destination: authoritative, but a keyed marker that
    // lands on a differently keyed entry is reported, not silently trusted
    if (dest?.type === "entry" && /^[[(]?[\w*†‡§¶]{1,4}[\])]?$/.test(c.sourceText.trim())) {
      const same = markerKey(dest.key ?? "") === markerKey(c.sourceText);
      return same
        ? { conf: 0.99, why: "linked marker lands on the entry with the same key" }
        : { conf: 0.8, why: `link lands on entry "${dest.key}" whose key differs from "${c.sourceText.trim()}"` };
    }
    return { conf: 0.95, why: "destination named by the file's own link" };
  }
  if (NOTE_TYPES.has(c.type) && c.method !== "line-key" && c.method !== "lemma-match") {
    if (!dest || dest.type !== "entry") return { conf: 0, why: "note reference does not land on a note entry" };
  }
  if (c.type === "structural-navigation" && !c.toSection && dest?.type !== "heading") {
    return { conf: 0, why: "structural reference does not land on a structural node" };
  }
  return { conf: base, why: "destination exists and fits the reference type" };
}

const overlaps = (a: Proposed, b: Proposed) =>
  a.marker.blockId === b.marker.blockId && a.marker.start < b.marker.end && b.marker.start < a.marker.end;

/**
 * Score, validate and reconcile every proposed candidate. Returns the final
 * reference edges and a record for every candidate considered.
 */
export function reconcile(
  proposed: Proposed[],
  ctx: ReconcileContext,
): { refs: Proposed[]; records: RecognitionRecord[] } {
  const blockById = new Map(ctx.blocks.map((b) => [b.id, b]));
  const sectionIds = new Set(ctx.structure.map((s) => s.id));
  const systemIds = new Set(ctx.systems.map((s) => s.id));
  const records = new Map<string, RecognitionRecord>();

  const record = (c: Proposed, recognition: number, destConf: number, decision: Decision, reason: string) => {
    records.set(c.id, {
      id: c.id,
      blockId: c.marker.blockId,
      start: c.marker.start,
      end: c.marker.end,
      text: c.sourceText,
      method: c.method,
      type: c.type,
      system: c.system,
      signals: c.signals.map((s) => (s.note ? `${s.kind}: ${s.note}` : s.kind)),
      recognition,
      destination: c.to ?? c.toSection,
      destinationConfidence: destConf,
      alternatives: (c.candidates ?? []).slice(0, 6).map((x) => ({ to: x.to, score: x.score, why: x.why })),
      decision,
      reason,
    });
  };

  // -- 1+2. recognition and destination validation, per candidate -----------
  const kept: (Proposed & { score: number; destConf: number })[] = [];
  for (const c of proposed) {
    const recognition = recognitionScore(c.signals);
    const v = validate(c, blockById, sectionIds, systemIds);
    if (v.conf > 0) {
      if (recognition >= ACCEPT_RESOLVED) {
        kept.push({ ...c, score: recognition, destConf: v.conf });
        record(c, recognition, v.conf, "accepted", v.why);
      } else {
        record(c, recognition, v.conf, "rejected", `recognition ${recognition} below ${ACCEPT_RESOLVED}: not functioning as a reference`);
      }
      continue;
    }
    // several plausible destinations: a recognised reference, kept ambiguous
    // with its scored candidates instead of an arbitrary pick
    if (c.ambiguous && (c.candidates?.length ?? 0) >= 2 && recognition >= ACCEPT_RESOLVED) {
      kept.push({ ...c, score: recognition, destConf: 0 });
      record(c, recognition, 0, "accepted-unresolved", `ambiguous among ${c.candidates!.length} plausible destinations`);
      continue;
    }
    // no valid destination: keep only strongly recognised candidates, unresolved
    if (recognition >= KEEP_UNRESOLVED) {
      const hadDest = !!(c.to || c.toSection);
      const demoted: Proposed = {
        ...c,
        ...(hadDest
          ? {
              to: null,
              toSection: null,
              destinationNodeId: null,
              method: "unresolved" as const,
              confidence: Math.min(c.confidence, 0.3),
              evidence: [...c.evidence, `destination rejected: ${v.why}`],
              candidates: [
                ...(c.candidates ?? []),
                { to: c.to ?? c.toSection ?? "", key: c.key, system: c.system ?? "", score: 0, why: `rejected: ${v.why}` },
              ],
              system: null,
            }
          : {}),
      };
      kept.push({ ...demoted, score: recognition, destConf: 0 });
      record(c, recognition, 0, "accepted-unresolved", hadDest ? `destination rejected: ${v.why}` : "strong recognition, no destination");
    } else {
      record(c, recognition, 0, "rejected", `recognition ${recognition} below ${KEEP_UNRESOLVED} with no valid destination`);
    }
  }

  // -- 3. reconcile candidates competing for the same characters --------------
  const rank = (c: (typeof kept)[number]) =>
    (c.provenance === "explicit-link" ? 10 : 0) + (c.destConf > 0 ? 2 : 0) + c.score + c.destConf;
  kept.sort((a, b) => rank(b) - rank(a));
  const final: (typeof kept)[number][] = [];
  for (const c of kept) {
    // two annotations in the file are both authoritative: never drop a link for another link
    const bothLinks = (f: Proposed) => f.provenance === "explicit-link" && c.provenance === "explicit-link";
    const rival = final.find((f) => overlaps(f, c) && !(bothLinks(f) && (f.to ?? f.toSection) !== (c.to ?? c.toSection)));
    if (!rival) {
      final.push(c);
      continue;
    }
    const same =
      rival.marker.start === c.marker.start && rival.marker.end === c.marker.end;
    const sameDest = (rival.to ?? rival.toSection) === (c.to ?? c.toSection);
    if (same || sameDest) {
      // the same reference seen by two detectors: one edge, both evidences
      rival.evidence = [...rival.evidence, ...c.evidence.map((e) => `also: ${e}`)];
      rival.signals = [...rival.signals, ...c.signals];
      if (!rival.system && c.system) rival.system = c.system;
      record(c, c.score, c.destConf, "merged", `same reference as ${rival.id} (${rival.method})`);
    } else {
      record(c, c.score, c.destConf, "rejected", `overlaps stronger candidate ${rival.id} (${rival.method}) on the same characters`);
    }
  }

  const refs = final.map(({ score, destConf, ...r }) => ({
    ...r,
    recognition: {
      score,
      destinationConfidence: destConf,
      signals: [...new Set(r.signals.map((s) => s.kind))],
    },
  }));
  return { refs, records: proposed.map((p) => records.get(p.id)!).filter(Boolean) };
}
