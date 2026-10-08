import { isProse, type Block, type RefEdge, type StructureNode } from "./types";

export interface BlockDiagnostic {
  tone: "ok" | "warn" | "bad";
  text: string;
}

/**
 * Everything the parser can say about a single reconstructed block, derived
 * from the model alone. These render inline so parser behaviour is visible
 * without reading any code.
 */
export function blockDiagnostics(
  block: Block,
  out: RefEdge[],
  incoming: RefEdge[],
  prev: Block | undefined,
  section: StructureNode | undefined,
): BlockDiagnostic[] {
  const d: BlockDiagnostic[] = [];

  if (block.type === "verse-line") {
    d.push({ tone: "ok", text: "classified as poetry (verse line)" });
    if (block.line != null && prev?.type === "verse-line" && prev.line != null) {
      const step = block.line - prev.line;
      if (step <= 0 || step > 12) {
        d.push({ tone: "bad", text: `line-number sequence broken: ${prev.line} → ${block.line}` });
      }
    }
    if (block.line == null) d.push({ tone: "warn", text: "verse line carries no line number" });
  }

  if (block.type === "heading") {
    d.push({
      tone: section ? "ok" : "warn",
      text: section
        ? `heading opens ${section.type} "${section.label}"${section.number != null ? ` (n=${section.number})` : ""}`
        : "heading did not open a structure node",
    });
    if (out.length) {
      d.push({ tone: "warn", text: `${out.length} reference(s) detected inside a heading — check for misclassification` });
    }
  }

  if (isProse(block.type)) {
    if (block.text.length > 1400) d.push({ tone: "warn", text: "very long paragraph — may have merged two PDF columns or two paragraphs" });
    if (/\b\d{1,4}\s{2,}\S/.test(block.text.slice(0, 12)))
      d.push({ tone: "warn", text: "paragraph opens with a bare number — possible un-stripped line number" });
  }

  if (block.type === "entry") {
    d.push({
      tone: incoming.length ? "ok" : "warn",
      text: incoming.length
        ? `apparatus entry ${block.key ?? ""} referenced from ${incoming.length} location(s)`
        : `apparatus entry ${block.key ?? ""} is orphaned — nothing points at it`,
    });
    if (block.lemma) d.push({ tone: "ok", text: `lemma: “${block.lemma}”` });
  }

  const labels = new Map<string, number>();
  for (const r of out) labels.set(r.label, (labels.get(r.label) ?? 0) + 1);
  for (const [label, n] of labels) {
    if (n > 1) d.push({ tone: "warn", text: `reference “${label}” occurs ${n}× in this block — possible duplicate` });
  }

  for (const r of out) {
    if (!r.to && !r.toSection) d.push({ tone: "bad", text: `“${r.label}” unresolved (${r.method})` });
    else if (r.confidence < 0.7)
      d.push({ tone: "warn", text: `“${r.label}” resolved by ${r.method} at ${Math.round(r.confidence * 100)}% confidence` });
    if (r.note) d.push({ tone: "warn", text: `“${r.label}”: ${r.note}` });
  }

  const systems = new Set(out.map((r) => r.system).filter(Boolean));
  if (systems.size > 1)
    d.push({ tone: "warn", text: `references from ${systems.size} different editorial systems share this block` });

  return d;
}

export function worstTone(list: BlockDiagnostic[]): "ok" | "warn" | "bad" | null {
  if (list.some((x) => x.tone === "bad")) return "bad";
  if (list.some((x) => x.tone === "warn")) return "warn";
  return list.length ? "ok" : null;
}

// ---------------------------------------------------------------------------
// Reference-source diagnostics (phase 3)
// ---------------------------------------------------------------------------

export interface RefSourceDiagnostic {
  refId: string;
  tone: "warn" | "bad";
  text: string;
}

/**
 * Audits the *source* side of the reference graph: anchoring quality rather
 * than resolution. A reference whose marker is empty, whose sentence covers the
 * whole paragraph, or which the parser refused to disambiguate will render a
 * misleading popup even when its destination is correct.
 */
export function refSourceDiagnostics(refs: RefEdge[]): RefSourceDiagnostic[] {
  const out: RefSourceDiagnostic[] = [];
  for (const r of refs) {
    const markerLen = Math.max(0, r.marker.end - r.marker.start);
    const sentenceLen = Math.max(0, r.sentence.end - r.sentence.start);
    const paraLen = Math.max(0, r.paragraph.end - r.paragraph.start);
    if (markerLen === 0) out.push({ refId: r.id, tone: "bad", text: `${r.key}: marker span is empty` });
    if (r.marker.start < r.sentence.start || r.marker.end > r.sentence.end)
      out.push({ refId: r.id, tone: "bad", text: `${r.key}: marker falls outside its sentence range` });
    if (sentenceLen === 0) out.push({ refId: r.id, tone: "bad", text: `${r.key}: empty source sentence` });
    else if (sentenceLen < 12 && r.type !== "line-note")
      out.push({ refId: r.id, tone: "warn", text: `${r.key}: source sentence is only ${sentenceLen} characters` });
    if (paraLen > 0 && sentenceLen === paraLen && paraLen > 400 && r.type !== "line-note")
      out.push({ refId: r.id, tone: "warn", text: `${r.key}: sentence segmentation failed — sentence equals the whole paragraph` });
    if (r.ambiguous)
      out.push({ refId: r.id, tone: "warn", text: `${r.key}: ${r.candidates?.length ?? 2} candidate destinations tie` });
    if (!r.to && !r.toSection) out.push({ refId: r.id, tone: "bad", text: `${r.key}: unresolved (${r.method})` });
    else if (r.confidence < 0.5)
      out.push({ refId: r.id, tone: "warn", text: `${r.key}: low confidence ${Math.round(r.confidence * 100)}%` });
    if (!r.evidence?.length) out.push({ refId: r.id, tone: "warn", text: `${r.key}: no recorded parser evidence` });
  }
  return out;
}
