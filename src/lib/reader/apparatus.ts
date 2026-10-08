import { markerClass, markerKey, type MarkerClass } from "./markers";
import type { RejectedSystem } from "./stages";
import { isProse, type Block, type RefSystem, type StructureNode, type SystemKind } from "./types";

const APPARATUS_TITLE =
  /(explanatory\s+)?(notes?|endnotes|commentary|bibliography|works\s+cited|further\s+reading|glossary|abbreviations|textual\s+notes?)/i;

const KEYED = /^\[?\s*(\d{1,4}(?:[–-]\d{1,4})?(?:ff?\.)?(?:\s*[a-z])?)\s*[\].):]?\s+(\S.*)$/;
const SYMBOL = /^(\*{1,3}|†{1,3}|‡{1,3}|§{1,3}|¶{1,3})\s*([^\s*†‡§¶].*)$/;
/** "iv. …", "(b) …", "[c] …" — the closing punctuation is required */
const LETTERED = /^[([]?([a-z]|[ivxlc]{1,6}|[IVXLC]{1,6})[)\].]\s+(\S.*)$/;
const AUTHOR_DATE = /^([A-Z][\w'’-]+),\s+[A-Z][^.]{0,60}[.,].*?\b(1[6-9]\d{2}|20\d{2})\b/;

export interface Matched {
  b: Block;
  key: string;
  /** everything after the key */
  rest: string;
  sym: boolean;
  /** character offset of the key inside b.text */
  keyAt: number;
  keyLength: number;
  /** the catchphrase this entry is keyed to, when the entry prints one */
  lemma: string | null;
  /** what kind of printed marker keys this entry */
  cls: MarkerClass;
}

/**
 * Recognize a keyed apparatus entry.
 *
 * Three printings are handled: key + space ("326 he sang…"), key + symbol, and
 * — the form this edition uses and the previous parser missed entirely — a key
 * set flush against a differently-set lemma with no intervening space
 * ("326he sang “The Homecoming of the Achaeans”: …"). The glued form is only
 * accepted on typographic evidence: the key must be its own run and the run
 * after it must be set differently (italic lemma).
 */
export function matchEntry(b: Block): Matched | null {
  const sym = b.text.match(SYMBOL);
  if (sym) return finish(b, sym[1]!, sym[2]!, true, b.text.indexOf(sym[1]!), sym[1]!.length, "symbol");

  const keyed = b.text.match(KEYED);
  if (keyed) {
    const at = b.text.indexOf(keyed[1]!);
    return finish(b, keyed[1]!, keyed[2]!, false, at < 0 ? 0 : at, keyed[1]!.length, "numeric");
  }

  // Roman-numeral and lettered keys must carry their own closing punctuation
  // ("iv. …", "(b) …") — a bare word at the head of a paragraph is prose.
  const lettered = b.text.match(LETTERED);
  if (lettered) {
    const key = lettered[1]!;
    const cls = markerClass(key.toLowerCase());
    if (cls === "roman" || cls === "alphabetic") {
      const at = b.text.indexOf(key);
      return finish(b, key.toLowerCase(), lettered[2]!, false, at < 0 ? 0 : at, key.length, cls);
    }
  }

  // a superscript key set as its own run at the head of the entry
  const head = b.runs[0];
  if (head?.sup && b.runs.length > 1) {
    const key = markerKey(head.t);
    const cls = markerClass(key);
    if (cls) {
      const at = b.text.indexOf(head.t.trim());
      return finish(b, key, b.text.slice(head.t.length).trimStart(), cls === "symbol", at < 0 ? 0 : at, head.t.trim().length, cls);
    }
  }

  const first = b.runs[0];
  const second = b.runs[1];
  if (first && second && /^\d{1,4}[a-z]?$/.test(first.t.trim()) && (second.em || second.sup === false)) {
    if (!second.em) return null;
    const key = first.t.trim();
    const at = b.text.indexOf(key);
    return finish(b, key, b.text.slice(key.length).replace(/^\s*/, ""), false, at < 0 ? 0 : at, key.length, "numeric");
  }
  return null;
}

/**
 * The lemma is the catchphrase between the key and the first colon. Falling back
 * to "first italic run" keeps entries whose lemma is set in italics but which
 * carry no colon at all.
 */
function finish(
  b: Block,
  key: string,
  rest: string,
  sym: boolean,
  keyAt: number,
  keyLength: number,
  cls: MarkerClass,
): Matched {
  let lemma: string | null = null;
  const colon = rest.search(/:\s/);
  if (colon > 0 && colon < 220) lemma = rest.slice(0, colon).trim();
  if (!lemma) {
    const emIdx = b.runs.findIndex((r) => r.em);
    if (emIdx >= 0 && b.runs.slice(0, emIdx).reduce((a, r) => a + r.t.length, 0) < 90) {
      lemma = b.runs[emIdx]!.t.trim().replace(/[:.,;]$/, "");
    }
  }
  if (lemma) lemma = lemma.replace(/\s+/g, " ").replace(/[:.,;]$/, "").trim() || null;
  return { b, key, rest, sym, keyAt, keyLength, lemma, cls };
}

/**
 * The catchphrase an unnumbered note entry opens with.
 *
 * Three printings, all decided from the entry's own typography and punctuation:
 * a quoted phrase, an italic phrase set at the head of the entry, or a short
 * phrase closed by a colon or dash. Nothing here knows any book's wording.
 */
export function openingLemma(b: Block): string | null {
  const text = b.text.trim();
  if (text.length < 4) return null;

  const quoted = text.match(/^["“‘']([^"”’']{2,140})["”’'](?:\s*[:,.—–-]|\s)/);
  if (quoted) return quoted[1]!.trim();

  const first = b.runs[0];
  if (first?.em && first.t.trim().length >= 3 && first.t.trim().length <= 120) {
    const rest = b.runs.slice(1).map((r) => r.t).join("").trim();
    if (rest.length > 0 && !b.runs.slice(1).every((r) => r.em)) {
      return first.t.trim().replace(/[:,.;—–-]+$/, "");
    }
  }

  const colon = text.search(/[:—–]\s/);
  if (colon > 2 && colon < 140) {
    const head = text.slice(0, colon).trim();
    // a full sentence is prose, not a lemma
    if (!/[.!?]/.test(head) && head.split(/\s+/).length <= 14) return head;
  }
  return null;
}



export interface ApparatusEntry {
  blockId: string;
  system: string;
  key: string;
  numeric: number | null;
  lemma: string | null;
  section: string;
}

function kindFor(label: string, grammar: string): SystemKind {
  const l = label.toLowerCase();
  if (/bibliograph|works cited|further reading/.test(l)) return "bibliography";
  if (/glossar/.test(l)) return "glossary";
  if (/textual/.test(l)) return "textual-apparatus";
  if (/commentar/.test(l)) return "line-commentary";
  if (grammar === "line-keyed" || grammar === "book-line") return "line-commentary";
  if (/footnote/.test(l)) return "footnote";
  return "endnote";
}

/**
 * Discover every editorial system present in the back matter, independently.
 * A scholarly edition routinely runs several at once (translator's notes keyed
 * to verse lines, editor's notes keyed sequentially, a glossary, a bibliography)
 * so nothing here assumes a single list.
 */
export function detectApparatus(
  blocks: Block[],
  structure: StructureNode[],
  hasVerse: boolean,
): { systems: RefSystem[]; entries: ApparatusEntry[]; rejected: RejectedSystem[] } {
  const byId = new Map(structure.map((s) => [s.id, s]));
  const ancestors = (id: string): StructureNode[] => {
    const chain: StructureNode[] = [];
    let cur = byId.get(id);
    while (cur) {
      chain.unshift(cur);
      cur = cur.parent ? byId.get(cur.parent) : undefined;
    }
    return chain;
  };

  // Every note collection in the back matter is its own namespace. A document
  // routinely nests them ("Notes" > "Notes on the Introduction" > "Notes on the
  // Translation"), so a nested collection must NOT be swallowed by its parent:
  // each candidate keeps only the blocks its children do not claim.
  const candidates = structure.filter(
    (s) => (s.type === "apparatus" || s.type === "appendix") && APPARATUS_TITLE.test(s.label),
  );
  const isDescendant = (child: StructureNode, parent: StructureNode) => {
    let cur: StructureNode | undefined = child.parent ? byId.get(child.parent) : undefined;
    while (cur) {
      if (cur.id === parent.id) return true;
      cur = cur.parent ? byId.get(cur.parent) : undefined;
    }
    return false;
  };
  const hosts = candidates.map((host) => {
    const claimed = candidates.filter((c) => c !== host && isDescendant(c, host));
    const own = (i: number) => !claimed.some((c) => i >= c.start && i < c.end);
    return { host, own };
  });
  void ancestors;

  const systems: RefSystem[] = [];
  const entries: ApparatusEntry[] = [];
  const rejected: RejectedSystem[] = [];
  let n = 0;

  for (const { host, own } of hosts) {
    const scoped = blocks
      .slice(host.start, host.end)
      .filter((b, i) => isProse(b.type) && own(host.start + i));
    if (scoped.length < 4) {
      rejected.push({ label: host.label, reason: `only ${scoped.length} paragraph(s) under the heading` });
      continue;
    }

    const matched = scoped.map(matchEntry).filter(Boolean) as Matched[];



    const bib = scoped.filter((b) => AUTHOR_DATE.test(b.text));
    const keyedRatio = matched.length / scoped.length;
    const bibRatio = bib.length / scoped.length;

    if (bibRatio > 0.45 && bibRatio >= keyedRatio) {
      const id = `sys${n++}`;
      systems.push({
        id,
        kind: "bibliography",
        label: host.label,
        grammar: "author-date",
        keyScope: "document",
        hosts: [host.id],
        typography: { size: 0, indent: 0, leading: 0, altFontLemma: false },
        entryCount: bib.length,
        evidence: [
          `${bib.length} blocks in "${host.label}" begin Surname, Forename … year`,
          "hanging-indent entry layout",
        ],
        confidence: Math.min(0.95, 0.6 + bibRatio / 2),
        samples: bib.slice(0, 3).map((b) => ({ key: b.text.match(AUTHOR_DATE)![1]!, text: b.text.slice(0, 160) })),
      });
      for (const b of bib) {
        const m = b.text.match(AUTHOR_DATE)!;
        const key = `${m[1] ?? ""} ${m[2] ?? ""}`.trim();
        if (!key) continue;
        b.type = "entry";
        b.system = id;
        b.key = key;
        entries.push({ blockId: b.id, system: id, key, numeric: null, lemma: null, section: b.section });
      }
      continue;
    }

    if (keyedRatio < 0.4 || matched.length < 4) {
      // No numeric or symbolic marker anywhere — but a note collection does not
      // need one. Many editions identify a note purely by the catchphrase it
      // quotes from the text ("the Guide, the Slayer of Argos: …"). That is a
      // reference system with a lemma namespace, and it is discovered from the
      // repeated entry grammar rather than from any marker.
      const lemmas = scoped.map((b) => ({ b, lemma: openingLemma(b) })).filter((x) => x.lemma) as {
        b: Block;
        lemma: string;
      }[];
      const lemmaRatio = lemmas.length / scoped.length;
      if (lemmas.length >= 4 && lemmaRatio >= 0.5) {
        const id = `sys${n++}`;
        systems.push({
          id,
          kind: /commentar/i.test(host.label) ? "line-commentary" : "endnote",
          label: host.label,
          grammar: "lemma-keyed",
          keyScope: "section",
          hosts: [host.id],
          typography: { size: 0, indent: 0, leading: 0, altFontLemma: true },
          entryCount: lemmas.length,
          evidence: [
            `${lemmas.length}/${scoped.length} blocks in "${host.label}" open with a quoted or set-off catchphrase`,
            "no numeric or symbolic marker is printed — the entries are keyed by lemma",
            "identifiers below are generated for the data model and are not printed in the book",
          ],
          confidence: Math.min(0.9, 0.45 + lemmaRatio * 0.45),
          samples: lemmas.slice(0, 3).map((x) => ({ key: x.lemma, text: x.b.text.slice(0, 160) })),
        });
        let auto = 0;
        for (const { b, lemma } of lemmas) {
          const key = `endnote-auto-${String(++auto).padStart(3, "0")}`;
          b.type = "entry";
          b.system = id;
          b.key = key;
          b.lemma = lemma;
          entries.push({ blockId: b.id, system: id, key, numeric: null, lemma, section: b.section });
        }
        continue;
      }
      rejected.push({
        label: host.label,
        reason: `only ${matched.length}/${scoped.length} paragraphs open with a recognisable key and ${lemmas.length} with a lemma — no entry grammar could be inferred`,
      });
      continue;
    }


    // One heading can host several independent systems at once (an author's
    // symbol notes beside an editor's numbered notes). Each marker class with
    // enough entries of its own becomes its own system; a stray minority entry
    // stays with the dominant class rather than inventing a system.
    const byClass = new Map<MarkerClass, Matched[]>();
    for (const m of matched) byClass.set(m.cls, [...(byClass.get(m.cls) ?? []), m]);
    const dominant = [...byClass.entries()].sort((a, b) => b[1].length - a[1].length)[0]![0];
    const groups: Matched[][] = [];
    const stray: Matched[] = [];
    for (const [cls, arr] of byClass) {
      if (cls === dominant || arr.length >= 3) groups.push(arr);
      else stray.push(...arr);
    }
    groups.find((g) => g[0]!.cls === dominant)!.push(...stray);
    const pos = new Map(scoped.map((b, i) => [b, i]));
    groups.forEach((g) => g.sort((a, b) => (pos.get(a.b) ?? 0) - (pos.get(b.b) ?? 0)));
    const split = groups.length > 1;
    for (const group of groups) {
      const cls = group[0]!.cls;
      const bracketed = group.filter((m) => m.b.text.trimStart().startsWith("[")).length > group.length / 2;
      const nums = group.map((m) => Number.parseInt(m.key, 10)).filter((v) => Number.isFinite(v));
      const resets = nums.filter((v, i) => i > 0 && v <= nums[i - 1]!).length;
      const maxKey = nums.length ? Math.max(...nums) : 0;
      const withLemma = group.filter((m) => {
        const em = m.b.runs.findIndex((r) => r.em);
        return em >= 0 && m.b.runs.slice(0, em).reduce((a, r) => a + r.t.length, 0) < 90;
      });
      const lemmaRatio = withLemma.length / group.length;

      // Keys that climb into the hundreds and reset at each division, attached to
      // a quoted catchphrase, are line references — not a sequential note list.
      const lineKeyed = hasVerse && maxKey > 60 && lemmaRatio > 0.4;
      const grammar: RefSystem["grammar"] = cls === "symbol"
        ? "symbol"
        : cls === "roman"
          ? "roman"
          : cls === "alphabetic"
            ? "alphabetic"
            : group[0]!.sym
        ? "symbol"
        : lineKeyed
          ? "line-keyed"
          : bracketed
            ? "bracketed"
            : "sequential";

      // where do the keys restart?
      let keyScope: RefSystem["keyScope"] = "document";
      if (resets > 0) {
        const inner = ancestorTypeInside(group.map((m) => m.b.section), byId);
        keyScope = lineKeyed ? "book" : inner;
      }

      const id = `sys${n++}`;
      const indent = 0;
      systems.push({
        id,
        kind: kindFor(host.label, grammar),
        label: split ? `${host.label} (${CLASS_LABEL[cls]})` : host.label,
        grammar,
        keyScope,
        hosts: [host.id],
        typography: { size: 0, indent, leading: 0, altFontLemma: lemmaRatio > 0.4 },
        entryCount: group.length,
        evidence: [
          `${group.length}/${scoped.length} blocks in "${host.label}" open with a ${CLASS_LABEL[cls]} key`,
          ...(split ? [`the heading hosts ${groups.length} marker classes — kept as independent systems`] : []),
          lineKeyed ? `keys reach ${maxKey} and reset per division → line references` : `keys are ${grammar}`,
          lemmaRatio > 0.4 ? "key followed by an italic lemma (catchphrase)" : "key followed by roman text",
          resets > 0 ? `keys restart ${resets}× → scope "${keyScope}"` : "keys run continuously → document scope",
        ],
        confidence: Math.min(0.97, 0.5 + keyedRatio * 0.4 + (lemmaRatio > 0.4 ? 0.1 : 0)),
        samples: group.slice(0, 3).map((m) => ({ key: m.key, text: m.rest.slice(0, 160) })),
      });

      for (const m of group) {
        const emIdx = m.b.runs.findIndex((r) => r.em);
        const lemma =
          emIdx >= 0 && m.b.runs.slice(0, emIdx).reduce((a, r) => a + r.t.length, 0) < 90
            ? m.b.runs[emIdx]!.t.trim().replace(/[:.,;]$/, "")
            : null;
        m.b.type = "entry";
        m.b.system = id;
        m.b.key = m.key;
        if (lemma) m.b.lemma = lemma;
        entries.push({
          blockId: m.b.id,
          system: id,
          key: m.key,
          numeric: cls === "numeric" && Number.isFinite(Number.parseInt(m.key, 10)) ? Number.parseInt(m.key, 10) : null,
          lemma,
          section: m.b.section,
        });
      }
    }
  }

  return { systems, entries, rejected };
}

function ancestorTypeInside(
  sectionIds: string[],
  byId: Map<string, StructureNode>,
): RefSystem["keyScope"] {
  const types = new Set<string>();
  for (const id of sectionIds) {
    const s = byId.get(id);
    if (s) types.add(s.type);
  }
  if (types.has("chapter")) return "chapter";
  if (types.has("book")) return "book";
  return "section";
}

const CLASS_LABEL: Record<MarkerClass, string> = {
  numeric: "numbered",
  symbol: "symbol",
  alphabetic: "lettered",
  roman: "roman-numeral",
};
