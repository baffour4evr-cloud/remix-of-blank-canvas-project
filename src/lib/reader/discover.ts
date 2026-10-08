// Reference-system discovery: a document-wide census taken *before* any marker
// is matched. It describes each note system (marker syntax, key vocabulary,
// whether numbering resets, where its entries live, how its markers are set in
// the running text) and the document's marker-usage habits. Recognition then
// uses these facts instead of assuming any one convention.

import type { ApparatusEntry } from "./apparatus";
import { GLUED_SYMBOL, markerClass, markerKey, type MarkerClass } from "./markers";
import type { Block, RefSystem } from "./types";

export type MarkerSetting = "superscript" | "bracketed" | "parenthesized" | "glued";

export interface SystemProfile {
  system: string;
  label: string;
  kind: RefSystem["kind"];
  grammar: RefSystem["grammar"];
  /** marker classes printed by the system's entries */
  classes: MarkerClass[];
  /** distinct keys, in first-seen document order */
  vocabulary: string[];
  entryCount: number;
  /** number of times the key sequence restarts (1, 2, 3, 1, 2 …) */
  resets: number;
  /** pages where the system's entries are printed */
  destinationPages: [number, number] | null;
  /** how the running text prints markers that match this system's keys */
  sourceSettings: Partial<Record<MarkerSetting, number>>;
  /** other systems sharing at least one key with this one */
  sharesKeysWith: string[];
}

export interface DocumentMarkerCensus {
  profiles: SystemProfile[];
  /** body tokens per setting and class, whether or not any system matches them */
  usage: Record<MarkerSetting, Partial<Record<MarkerClass, number>>>;
  /** settings the document demonstrably uses for its markers (sequence evidence) */
  confirmedSettings: MarkerSetting[];
}

const BRACKETED = /\[\s?(\d{1,3}|\*{1,3}|†{1,3}|‡{1,3})\s?\]/g;
const PARENTHESIZED = /(?<=[\p{L}.,;:!?'"’”])\s?\((\d{1,3})\)(?![\p{L}\p{N}])/gu;

/** Longest run of tokens where each next key is previous+1 (resets to 1 allowed). */
function sequenceRun(keys: number[]): number {
  let best = 0;
  let run = 0;
  let prev = 0;
  for (const k of keys) {
    if (k === prev + 1 || (k === 1 && prev > 0)) run = k === 1 ? 1 : run + 1;
    else if (k !== prev) run = k === 1 ? 1 : 0;
    prev = k;
    best = Math.max(best, run);
  }
  return best;
}

export function discoverReferenceSystems(
  bodyBlocks: Block[],
  blocks: Block[],
  systems: RefSystem[],
  entries: ApparatusEntry[],
): DocumentMarkerCensus {
  const pageOf = new Map(blocks.map((b) => [b.id, b.page]));
  const usage: DocumentMarkerCensus["usage"] = { superscript: {}, bracketed: {}, parenthesized: {}, glued: {} };
  const tokens: { setting: MarkerSetting; key: string }[] = [];
  const parenNumbers: number[] = [];
  const bump = (setting: MarkerSetting, key: string) => {
    const cls = markerClass(key);
    if (!cls) return;
    usage[setting][cls] = (usage[setting][cls] ?? 0) + 1;
    tokens.push({ setting, key });
  };
  for (const b of bodyBlocks) {
    if (b.type === "heading" || b.type === "entry") continue;
    for (const r of b.runs) if (r.sup) bump("superscript", markerKey(r.t));
    for (const m of b.text.matchAll(BRACKETED)) bump("bracketed", markerKey(m[1]!));
    for (const m of b.text.matchAll(PARENTHESIZED)) {
      bump("parenthesized", m[1]!);
      parenNumbers.push(Number(m[1]));
    }
    for (const m of b.text.matchAll(GLUED_SYMBOL)) bump("glued", m[1]!);
  }

  const bySystem = new Map<string, ApparatusEntry[]>();
  for (const e of entries) bySystem.set(e.system, [...(bySystem.get(e.system) ?? []), e]);
  const keysOf = new Map<string, Set<string>>();
  for (const [id, es] of bySystem) keysOf.set(id, new Set(es.map((e) => markerKey(typeof e.key === "string" ? e.key : ""))));

  const profiles: SystemProfile[] = [];
  for (const s of systems) {
    const es = bySystem.get(s.id) ?? [];
    if (!es.length) continue;
    const vocabulary: string[] = [];
    const classes = new Set<MarkerClass>();
    let resets = 0;
    let prevNum: number | null = null;
    for (const e of es) {
      const k = markerKey(typeof e.key === "string" ? e.key : "");
      if (!vocabulary.includes(k)) vocabulary.push(k);
      const cls = markerClass(k);
      if (cls) classes.add(cls);
      const n = /^\d+$/.test(k) ? Number(k) : null;
      if (n != null && prevNum != null && n < prevNum) resets++;
      if (n != null) prevNum = n;
    }
    const keys = keysOf.get(s.id)!;
    const sourceSettings: SystemProfile["sourceSettings"] = {};
    for (const t of tokens) if (keys.has(t.key)) sourceSettings[t.setting] = (sourceSettings[t.setting] ?? 0) + 1;
    const pages = es.map((e) => pageOf.get(e.blockId) ?? 0).filter((p) => p > 0);
    profiles.push({
      system: s.id,
      label: s.label,
      kind: s.kind,
      grammar: s.grammar,
      classes: [...classes],
      vocabulary: vocabulary.slice(0, 60),
      entryCount: es.length,
      resets,
      destinationPages: pages.length ? [Math.min(...pages), Math.max(...pages)] : null,
      sourceSettings,
      sharesKeysWith: [...keysOf]
        .filter(([id, ks]) => id !== s.id && [...ks].some((k) => keys.has(k)))
        .map(([id]) => id),
    });
  }

  // A setting is confirmed for the document when its tokens form a numbering
  // sequence (1, 2, 3 …) — typography alone ("(12)" could be a list item) is not enough.
  const confirmedSettings: MarkerSetting[] = ["superscript", "bracketed", "glued"];
  if (sequenceRun(parenNumbers) >= 3) confirmedSettings.push("parenthesized");
  return { profiles, usage, confirmedSettings };
}
