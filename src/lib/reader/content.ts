import { verseGateFor } from "../engine/adapt";
import type { DocProfile, PageLines } from "./layout";
import { modeOf, type Line } from "./lines";
import type { Block, Provenance, RawDoc, StructureNode, StructureType, Run } from "./types";

const ROMAN = /^[IVXLCDM]+$/i;

/** A line that opens a keyed apparatus entry ("326 the sang…", "[4] …", "* …"). */
const ENTRY_OPENER = /^[[(]?\s*(\d{1,4}[a-z]?|[*†‡§¶]+|[IVXLC]+)\s*[\].):]?\s+\S/;

const round = (n: number) => Math.round(n * 10) / 10;

/**
 * True when the line's first typographic run is a bare key ("326") immediately
 * followed by a differently-set run — the way this edition prints its keyed
 * commentary entries, with no space between key and lemma.
 */
function startsWithKeyRun(l: Line): boolean {
  const first = l.runs[0];
  const second = l.runs[1];
  if (!first || !second) return false;
  if (!/^\s*\d{1,4}[a-z]?\s*$/.test(first.t)) return false;
  return second.em || second.f !== first.f || /^\s/.test(second.t);
}

/** Mode of the small vertical gaps on a page — the intra-paragraph leading. */
function localLeadingOf(lines: Line[]): number {
  const gaps = lines.map((l) => l.gap).filter((g) => g > 2 && g < 60);
  if (gaps.length < 4) return 0;
  return modeOf(gaps, 0.5);
}

function median(ns: number[]): number {
  if (!ns.length) return 0;
  const s = [...ns].sort((a, b) => a - b);
  return s[s.length >> 1]!;
}

/**
 * How precisely this page's geometry can be measured.
 *
 * A typeset text layer places every line of a paragraph on exactly the same
 * leading and every continuation exactly on the measure. Text recovered from a
 * photographed page does not: baselines and left edges wobble by a pixel or
 * two. Measuring that wobble — rather than assuming it — lets the same
 * paragraph rules serve both, and costs a clean page nothing, because its
 * wobble is zero.
 */
function noiseOf(lines: Line[], leading: number): { gap: number; left: number } {
  const gaps = lines.map((l) => l.gap).filter((g) => g > 2 && g < leading * 1.6);
  const lefts = lines.map((l) => l.x);
  const leftMode = modeOf(lefts, 1) || median(lefts);
  const gapDev = median(gaps.map((g) => Math.abs(g - leading)));
  const leftDev = median(lefts.filter((x) => Math.abs(x - leftMode) < 12).map((x) => Math.abs(x - leftMode)));
  // 3 deviations covers ordinary jitter without reaching a real indent (which
  // is a whole em or more) or a real paragraph space.
  return { gap: Math.min(6, 3 * gapDev), left: Math.min(5, 3 * leftDev) };
}


export function romanToInt(s: string): number | null {
  if (!ROMAN.test(s)) return null;
  const map: Record<string, number> = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };
  let total = 0;
  const up = s.toUpperCase();
  for (let i = 0; i < up.length; i++) {
    const v = map[up[i]!]!;
    const next = map[up[i + 1]!] ?? 0;
    total += v < next ? -v : v;
  }
  return total;
}

const WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
  eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50,
};

export function parseNumber(token: string): number | null {
  if (/^\d+$/.test(token)) return Number(token);
  const words = token.toLowerCase().split(/[\s-]+/).filter(Boolean);
  if (words.length && words.every((w) => w in WORDS)) {
    return words.reduce((a, w) => a + WORDS[w]!, 0);
  }
  return romanToInt(token);
}

const DIVISION =
  /^(book|volume|part|chapter|canto|act|scene|section|appendix|letter)\s+([0-9]+|[IVXLCDM]+|[A-Za-z]+(?:-[A-Za-z]+)?)\b[.:—–-]?\s*(.*)$/i;


const APPARATUS_TITLE =
  /^(explanatory\s+)?(notes?|endnotes|commentary|bibliography|works\s+cited|further\s+reading|suggestions\s+for\s+further\s+reading|glossary|index|abbreviations|textual\s+notes?|list\s+of\s+illustrations|illustrations)\b/i;

const FRONT_TITLE =
  /^(contents|introduction|preface|foreword|translator|acknowledg|a note on|dedication|title page|copyright|about the|chronology|maps?)\b/i;

const TYPE_BY_WORD: Record<string, StructureType> = {
  volume: "volume",
  book: "book",
  part: "part",
  chapter: "chapter",
  canto: "chapter",
  act: "chapter",
  scene: "section",
  letter: "chapter",
  section: "section",
  appendix: "appendix",
};

const RANK: Record<StructureType, number> = {
  root: -1,
  frontmatter: 0,
  apparatus: 0,
  appendix: 0,
  volume: 0,
  book: 1,
  part: 1,
  chapter: 2,
  section: 3,
};

interface HeadingInfo {
  type: StructureType;
  label: string;
  number: number | null;
  title: string;
}

function classifyHeading(text: string): HeadingInfo {
  const clean = text.replace(/\s+/g, " ").trim();
  const div = clean.match(DIVISION);
  const divNumber = div ? parseNumber(div[2]!) : null;
  if (div && divNumber != null) {
    const word = div[1]!.toLowerCase();
    return {
      type: TYPE_BY_WORD[word] ?? "section",
      label: `${div[1]![0]!.toUpperCase()}${div[1]!.slice(1).toLowerCase()} ${divNumber}`,
      number: divNumber,
      title: (div[3] ?? "").trim(),
    };
  }

  if (APPARATUS_TITLE.test(clean)) return { type: "apparatus", label: clean, number: null, title: clean };
  if (FRONT_TITLE.test(clean)) return { type: "frontmatter", label: clean, number: null, title: clean };
  return { type: "section", label: clean, number: null, title: clean };
}

function isCenteredCaps(l: Line, p: PageLines, profile: DocProfile): boolean {
  if (l.text.length > 70 || l.text.length < 3) return false;
  const leftGap = l.x - profile.bodyIndent;
  const rightGap = profile.maxRight - l.right;
  const centered = leftGap > 25 && rightGap > 25 && Math.abs(leftGap - rightGap) < Math.max(30, p.width * 0.06);
  const caps = /^[^a-z]+$/.test(l.text) && /[A-Z]/.test(l.text);
  return centered && caps;
}

/**
 * Text zone of a line: the left edge of its measure, and whether the run of
 * lines it belongs to is verse.
 *
 * Verse is decided per *region*, never per page: a commentary page can quote
 * twenty lines of poetry, and a poem page can carry a prose note. The evidence
 * is geometric — a region indented past the prose measure whose lines stop well
 * short of the right margin (or that carries marginal stichometry) is verse;
 * an indented region that fills the measure is a prose block quote.
 */
export interface Zone {
  verse: boolean;
  /** left edge of the region's text, ignoring outdented line numbers */
  left: number;
}

/** Marginal number outdented from the measure, e.g. "220" before a verse line. */
function marginNumbers(l: Line): { left: number; right: number } {
  let left = l.x;
  let right = l.right;
  const runs = l.runs.filter((r) => r.t.trim() !== "");
  const first = runs[0];
  const second = runs[1];
  if (first && second && /^\d{1,4}$/.test(first.t.trim()) && second.x - first.x > first.t.length * l.size * 0.5 + 4) {
    left = second.x;
  }
  const last = runs[runs.length - 1];
  const penult = runs[runs.length - 2];
  if (last && penult && /^\d{1,4}$/.test(last.t.trim()) && last.x - penult.x > 30) {
    right = penult.x;
  }
  return { left, right };
}

export function zonesFor(body: Line[], profile: DocProfile): Map<Line, Zone> {
  const bodyWidth = Math.max(80, profile.maxRight - profile.proseLeft);
  const info = body.map((l) => {
    const m = marginNumbers(l);
    return { l, ...m, numbered: m.left !== l.x || m.right !== l.right };
  });
  // pdf.js often emits an outdented stichometric number inside the same text item
  // as the line it numbers, so geometry alone cannot separate them: recover the
  // measure from the unnumbered neighbours instead.
  for (let k = 0; k < info.length; k++) {
    const rec = info[k]!;
    if (rec.numbered || !/^\d{1,4}\s+\S/.test(rec.l.text)) continue;
    const neighbour = info[k - 1] ?? info[k + 1];
    const left = neighbour && !/^\d{1,4}\s+\S/.test(neighbour.l.text) ? neighbour.left : null;
    if (left != null && left > rec.left + 8 && left - rec.left < 70) {
      rec.left = left;
      rec.numbered = true;
    }
  }
  const out = new Map<Line, Zone>();
  let i = 0;
  while (i < info.length) {
    if (info[i]!.left < profile.proseLeft + 24) {
      out.set(info[i]!.l, { verse: false, left: profile.proseLeft });
      i++;
      continue;
    }
    let j = i;
    while (j < info.length && info[j]!.left >= profile.proseLeft + 24) j++;
    const group = info.slice(i, j);
    const left = modeOf(group.map((g) => g.left), 1);
    const full = group.filter((g) => g.right - g.left > bodyWidth * 0.4);
    const rights = full.map((g) => g.right).sort((a, b) => a - b);
    const medianRight = rights[Math.floor(rights.length / 2)] ?? 0;
    // Verse capitalizes the head of every metrical line, so a capital opening a
    // line whose predecessor did not end a sentence is lineation, not wrapping.
    let midCaps = 0;
    for (let k = 1; k < group.length; k++) {
      const prev = group[k - 1]!.l.text;
      const cur = group[k]!.l.text;
      if (/[.!?:;”’"]\s*$/.test(prev)) continue;
      if (/^[“"'(]?[A-Z\u0391-\u03A9]/.test(cur)) midCaps++;
    }
    const verse =
      group.some((g) => g.numbered) ||
      medianRight < profile.maxRight - bodyWidth * 0.12 ||
      (group.length > 2 && midCaps / (group.length - 1) >= 0.5);
    for (const g of group) out.set(g.l, { verse, left });
    i = j;
  }
  return out;
}

function looksHanging(lines: Line[], profile: DocProfile): boolean {
  const xs = lines.map((l) => Math.round(l.x));
  if (xs.length < 6) return false;
  const min = Math.min(...xs);
  const atMin = xs.filter((x) => x <= min + 3).length;
  return atMin / xs.length < 0.45 && Math.max(...xs) - min > 8;
}

export interface ContentResult {
  blocks: Block[];
  structure: StructureNode[];
  verseSections: number;
  /** fused words the normalizer split apart, with the evidence-backed result */
  repairedTokens: string[];
  /** embedded regions recovered from the page geometry */
  embedded: { type: string; count: number }[];
}

export function buildContent(doc: RawDoc, pages: PageLines[], profile: DocProfile): ContentResult {
  const blocks: Block[] = [];
  const structure: StructureNode[] = [];
  const stack: StructureNode[] = [];

  const root: StructureNode = {
    id: "s0",
    type: "root",
    label: doc.meta.title ?? "Document",
    number: null,
    title: doc.meta.title ?? "Document",
    page: 1,
    parent: null,
    depth: 0,
    start: 0,
    end: 0,
  };
  structure.push(root);
  stack.push(root);

  // The PDF outline, when present, is the most reliable statement of the
  // document's top-level shape. Detected headings are matched against it rather
  // than competing with it, so "Book One" (outline) and "Book 1" (page) are one
  // node, and a division heading inside the back matter cannot escape it.
  const spine = doc.outline
    .filter((o) => o.page != null)
    .map((o) => ({ page: o.page!, depth: o.depth, info: classifyHeading(o.title.replace(/\s+/g, " ").trim()) }));
  let spineIdx = 0;

  let sid = 1;
  let bid = 0;
  const newId = () => `b${bid++}`;
  const meta = new Map<string, { spine: boolean; sdepth: number }>();
  meta.set("s0", { spine: true, sdepth: -1 });

  const makeNode = (info: HeadingInfo, page: number) => {
    const parent = stack[stack.length - 1]!;
    const node: StructureNode = {
      id: `s${sid++}`,
      type: info.type,
      label: info.label,
      number: info.number,
      title: info.title,
      page,
      parent: parent.id,
      depth: stack.length,
      start: blocks.length,
      end: blocks.length,
    };
    structure.push(node);
    stack.push(node);
    return node;
  };

  const pushSpine = (info: HeadingInfo, page: number, depth: number) => {
    while (stack.length > 1) {
      const top = meta.get(stack[stack.length - 1]!.id)!;
      if (top.spine && top.sdepth < depth) break;
      stack.pop()!.end = blocks.length;
    }
    const node = makeNode(info, page);
    meta.set(node.id, { spine: true, sdepth: depth });
    return node;
  };

  const pushSection = (info: HeadingInfo, page: number) => {
    const rank = RANK[info.type];
    while (stack.length > 1) {
      const top = stack[stack.length - 1]!;
      if (meta.get(top.id)!.spine) break;
      if (RANK[top.type] < rank) break;
      stack.pop()!.end = blocks.length;
    }
    const node = makeNode(info, page);
    meta.set(node.id, { spine: false, sdepth: 99 });
    return node;
  };

  const currentSection = () => stack[stack.length - 1]!;


  let verseCounter = 0;
  interface Open {
    block: Block;
    /** left edge of the block's first line */
    left: number;
    /** left edge of its continuation lines, once one has been seen */
    contLeft: number | null;
    lastRight: number;
    /** the block opened with an apparatus-style key */
    entry: boolean;

  }
  let open: Open | null = null;

  const closeBlock = () => {
    open = null;
  };

  /** identities of the source spans a line was built from */
  const sourcesOf = (l: Line) =>
    l.runs
      .filter((r) => r.o != null)
      .map((r) => ({ page: r.page ?? l.page, o: r.o! }));

  const provOf = (l: Line): Provenance => ({
    page: l.page,
    pages: [l.page],
    boxes: [{ page: l.page, x: round(l.x), y: round(l.y), w: round(l.right - l.x), h: round(l.size) }],
    lines: 1,
    sources: sourcesOf(l),
  });

  const extendProv = (b: Block, l: Line) => {
    const p = b.prov;
    if (!p) return;
    if (!p.pages.includes(l.page)) p.pages.push(l.page);
    p.boxes.push({ page: l.page, x: round(l.x), y: round(l.y), w: round(l.right - l.x), h: round(l.size) });
    p.lines += 1;
    if (p.sources) p.sources.push(...sourcesOf(l));
  };

  const pushBlock = (b: Block) => {
    blocks.push(b);
    return b;
  };

  const lexicon = buildLexicon(pages);
  const verseSectionIds = new Set<string>();
  const bodyWidth = Math.max(80, profile.maxRight - profile.proseLeft);
  const verseGate = verseGateFor(pages, profile.bodySize, profile.leading || 14);
  if (verseGate) console.info("[verse-gate]", verseGate.reason);

  for (const p of pages) {
    const body = p.lines.filter((l) => !l.furniture);
    const zones = zonesFor(body, profile);
    if (verseGate) {
      for (const [line, zone] of zones) {
        if (zone.verse && !verseGate.allows(line)) zones.set(line, { ...zone, verse: false });
      }
    }
    // Leading is a *local* property: commentary is set tighter than the poem, and
    // a global mode makes every second line of a note look like a new paragraph.
    const localLeading = localLeadingOf(body) || profile.leading || 14;
    const noise = noiseOf(body, localLeading);
    let firstBodyLine = true;

    // open every outline node that starts on or before this page
    const opened: HeadingInfo[] = [];
    while (spineIdx < spine.length && spine[spineIdx]!.page <= p.page) {
      const entry = spine[spineIdx]!;
      pushSpine(entry.info, p.page, entry.depth);
      opened.push(entry.info);
      verseCounter = 0;
      spineIdx++;
    }
    const duplicatesSpine = (info: HeadingInfo) =>
      opened.some(
        (o) =>
          (o.number != null && o.number === info.number && o.type === info.type) ||
          o.title.toLowerCase().replace(/[^a-z0-9]/g, "") === info.title.toLowerCase().replace(/[^a-z0-9]/g, ""),
      );

    body.forEach((l, li) => {
      const big = l.size > profile.bodySize * 1.12;
      // A heading is not merely large type: it is a line set apart. Measured
      // text sizes wobble (badly so on a photographed page), so size alone
      // promotes ordinary run-on lines. Require the typographic signals a
      // heading always has and a running line never does — it opens like an
      // opening, and it stands clear of the line above.
      const t = l.text.trim();
      const opensLine = !/^[a-z‘“"(]/.test(t) && !/^[-–—,;:]/.test(t);
      const endsOpen = /[,;:]$|[a-z-]$/.test(t) && !/^[IVXLC]+\.?$/i.test(t);
      const setApart = li === 0 || l.gap >= localLeading * 1.3 - noise.gap;
      const headingShape = opensLine && (!endsOpen || t.length < 40) && setApart;
      const isHeading = (big && t.length < 90 && headingShape) || isCenteredCaps(l, p, profile);

      if (isHeading) {
        closeBlock();
        const info = classifyHeading(l.text);
        const node = duplicatesSpine(info) ? currentSection() : pushSection(info, p.page);
        verseCounter = 0;

        pushBlock({
          id: newId(),
          page: p.page,
          type: "heading",
          level: node.depth,
          section: node.id,
          runs: lineRuns(l),
          text: l.text,
          prov: provOf(l),
        });
        firstBodyLine = false;
        return;
      }

      const section = currentSection();
      const zone = zones.get(l) ?? { verse: false, left: profile.proseLeft };
      const verse = zone.verse;
      if (verse) verseSectionIds.add(section.id);

      if (verse) {
        // strip marginal stichometry from either margin
        let text = l.text;
        let explicit: number | null = null;
        const leftNum = text.match(/^(\d{1,4})\s+(.*)$/);
        if (leftNum && l.x <= zone.left - 10) {
          explicit = Number(leftNum[1]);
          text = leftNum[2]!;
        }
        const rightNum = text.match(/^(.*?)\s+(\d{1,4})$/);
        if (!explicit && rightNum && l.right >= profile.maxRight - 12) {
          explicit = Number(rightNum[2]);
          text = rightNum[1]!;
        }

        // A turn-over is the *remainder* of a metrical line that would not fit:
        // it is indented, short, and follows a line that ran to the right margin.
        // A speech opening or a quoted block is also indented but keeps full
        // measure, so width — not indentation alone — is the discriminator.
        const prevLine = body[li - 1];
        const width = l.right - l.x;
        const turnedOver =
          explicit == null &&
          l.x > zone.left + 8 &&
          width < bodyWidth * 0.5 &&
          !!prevLine &&
          prevLine.right >= profile.maxRight * 0.8 &&
          !/^\(\s*\d/.test(l.text) &&
          blocks.length > 0 &&
          blocks[blocks.length - 1]!.type === "verse-line";

        if (explicit != null) verseCounter = explicit;
        else if (!turnedOver) verseCounter += 1;

        if (turnedOver) {
          const prev = blocks[blocks.length - 1]!;
          const joiner = joinerFor(prev.text, text, lexicon);
          if (joiner === "" || joiner === "-") prev.text = prev.text.replace(/[-\u2010]$/, "");
          prev.text = `${prev.text}${joiner}${text}`.replace(/\s+/g, " ");
          prev.runs = mergeRuns(prev.runs, lineRuns(l), joiner);
          extendProv(prev, l);
          firstBodyLine = false;
          return;
        }

        pushBlock({
          id: newId(),
          page: p.page,
          type: "verse-line",
          section: section.id,
          runs: lineRuns(l, explicit),
          text,
          line: verseCounter,
          prov: provOf(l),
        });
        open = null;
        firstBodyLine = false;
        return;
      }

      // ----- prose ----------------------------------------------------------
      const startsEntry = ENTRY_OPENER.test(l.text) || startsWithKeyRun(l);
      /** a key with an explicit delimiter ("12." "[4]" "3)") is unambiguous */
      const hardKey = /^[[(]?\s*(\d{1,4}[a-z]?|[*†‡§¶]+)\s*[\].):]\s+\S/.test(l.text);
      // The measure a running paragraph is set to. Continuation lines define it;
      // before one exists, fall back to the page's body indent. Comparing against
      // the *opening* line instead would make an indented first line immune to
      // every later indent, which collapses whole chapters of dialogue into one
      // node.
      const measureLeft = open ? (open.contLeft ?? open.left) : 0;
      // A hanging-indent entry sets its first line flush and every continuation
      // slightly in, so the first indent after a full-measure opening line is a
      // continuation, not a new paragraph.
      const hangingCont =
        !!open &&
        open.contLeft == null &&
        l.x - open.left > 0 &&
        l.x - open.left < 24 &&
        (open.entry || open.lastRight >= profile.maxRight - 14);
      const indented = !!open && l.x > measureLeft + 6 + noise.left && !hangingCont;
      const prevEndsSentence = !!open && /[.!?”’"]\s*$/.test(open.block.text);
      const prevRanShort = !!open && open.lastRight < profile.maxRight - bodyWidth * 0.12;

      let startNew: boolean;
      if (!open) {
        startNew = true;
      } else if (firstBodyLine) {
        // page boundary: a paragraph that ran to the right margin on the previous
        // page continues here unless this line announces something new.
        const ranToMargin = open.lastRight >= profile.maxRight - 14;
        startNew = !ranToMargin || indented || startsEntry;
      } else if (l.gap > localLeading + 2.5 + noise.gap) {
        startNew = true;
      } else if (indented) {
        startNew = true;
      } else if (startsEntry && open.contLeft != null && l.x <= open.contLeft - 6) {
        // a new apparatus key printed out to the left of the running measure
        startNew = true;
      } else if (prevRanShort && prevEndsSentence) {
        // an unindented edition still signals the break typographically: the
        // previous line stopped well short of the measure and closed a sentence
        startNew = true;
      } else {
        startNew = false;
      }

      // An apparatus list is set solid: successive entries are one leading apart
      // and share the key's indent, so geometry alone cannot separate them. A new
      // key printed at (or left of) the block's continuation indent starts a new
      // entry — required, otherwise a whole note list collapses into one node.
      if (!startNew && open && startsEntry && l.x <= (open.contLeft ?? open.left) + 2 && (hardKey || open.entry)) {
        startNew = true;
      }


      if (startNew) {
        const block = pushBlock({
          id: newId(),
          page: p.page,
          type: "paragraph",
          section: section.id,
          runs: lineRuns(l),
          text: l.text,
          prov: provOf(l),
        });
        open = { block, left: l.x, contLeft: null, lastRight: l.right, entry: startsEntry };
      } else if (open) {
        const joiner = joinerFor(open.block.text, l.text, lexicon);
        if (joiner === "" || joiner === "-") open.block.text = open.block.text.replace(/[-\u2010]$/, "");
        open.block.text = `${open.block.text}${joiner}${l.text}`.replace(/\s+/g, " ");
        open.block.runs = mergeRuns(stripSoftBreak(open.block.runs, joiner), lineRuns(l), joiner);
        extendProv(open.block, l);
        open.lastRight = l.right;
        open.contLeft = open.contLeft == null ? l.x : Math.min(open.contLeft, l.x);
      }

      firstBodyLine = false;
    });
  }

  while (stack.length) stack.pop()!.end = blocks.length;

  root.end = blocks.length;
  for (const s of structure) if (verseSectionIds.has(s.id)) s.verse = true;
  const repairedTokens = repairGluedTokens(blocks, lexicon);
  classifyEmbedded(blocks, profile, structure);

  const embeddedCounts = new Map<string, number>();
  for (const b of blocks) {
    if (b.type === "blockquote" || b.type === "letter" || b.type === "list-item") {
      embeddedCounts.set(b.type, (embeddedCounts.get(b.type) ?? 0) + 1);
    }
  }
  return {
    blocks,
    structure,
    verseSections: verseSectionIds.size,
    repairedTokens,
    embedded: [...embeddedCounts].map(([type, count]) => ({ type, count })),
  };
}

function lineRuns(l: Line, stripLeadingNumber?: number | null): Run[] {
  const runs: Run[] = [];
  let skipped = stripLeadingNumber == null;
  for (const r of l.runs) {
    const t = r.t;
    if (!t.trim() && !runs.length) continue;
    if (!skipped) {
      if (new RegExp(`^\\s*${stripLeadingNumber}\\s*$`).test(t)) {
        skipped = true;
        continue;
      }
      skipped = true;
    }
    const run: Run = {
      t,
      ...(r.o != null ? { sources: [{ page: r.page ?? l.page, o: r.o }] } : {}),
    };
    if (r.em) run.em = true;
    if (r.sup) run.sup = true;
    if (r.sc) run.sc = true;
    if (r.strong) run.strong = true;
    runs.push(run);

  }
  return compact(runs);
}

function mergeRuns(a: Run[], b: Run[], joiner = " "): Run[] {
  const out = [...a];
  if (joiner) out.push({ t: joiner });
  return compact(out.concat(b));
}

function compact(runs: Run[]): Run[] {
  const out: Run[] = [];
  for (const r of runs) {
    const last = out[out.length - 1];
    if (
      last &&
      !!last.em === !!r.em &&
      !!last.strong === !!r.strong &&
      !!last.sup === !!r.sup &&
      !!last.sub === !!r.sub &&
      !!last.code === !!r.code &&
      !!last.sc === !!r.sc &&
      last.ref === r.ref
    ) {
      last.t += r.t;
      if (r.sources?.length) last.sources = [...(last.sources ?? []), ...r.sources];
    }
    else out.push({ ...r });
  }
  for (const r of out) r.t = r.t.replace(/\s+/g, " ");
  return out.filter((r) => r.t !== "");
}

/** One- and two-letter strings that really are words, so are not word fragments. */
const SHORT_WORDS = new Set([
  "a", "i", "o", "ah", "am", "an", "as", "at", "be", "by", "do", "go", "ha", "he", "hi", "if",
  "in", "is", "it", "la", "lo", "me", "mr", "ms", "my", "no", "of", "oh", "on", "or", "ox", "so",
  "to", "up", "us", "we", "ye", "yo",
]);

/**
 * How two physical lines join into one semantic line of text.
 *
 * Returns "" when the break falls *inside* a word — either a real hyphenation,
 * or (as in ebook-converted PDFs) a word simply cut in two with no hyphen at
 * all, which is what turns "too" into "t" + "oo.".
 */
export interface Lexicon {
  /** compounds seen printed with a hyphen away from any line break */
  hyphenated: Set<string>;
  /** plain word forms seen anywhere in the document, with their frequency */
  words: Map<string, number>;
  /** adjacent word pairs printed with a space, with their frequency */
  bigrams: Map<string, number>;
}

/**
 * Build the document's own evidence about hyphenation. A break-hyphen and a
 * real compound look identical at the end of a line, so the only non-arbitrary
 * discriminator is whether the document prints the compound hyphenated
 * somewhere it did *not* have to break, or prints the fused word.
 */
export function buildLexicon(pages: PageLines[]): Lexicon {
  const hyphenated = new Set<string>();
  const words = new Map<string, number>();
  const bigrams = new Map<string, number>();
  for (const p of pages) {
    for (const l of p.lines) {
      const text = l.text;
      for (const m of text.matchAll(/[A-Za-z\u00C0-\u024F']+/g)) {
        const w = m[0]!.toLowerCase();
        if (w.length >= 2) words.set(w, (words.get(w) ?? 0) + 1);
      }
      const seq = text.toLowerCase().match(/[a-z\u00C0-\u024F']+/g) ?? [];
      for (let i = 1; i < seq.length; i++) {
        const key = `${seq[i - 1]} ${seq[i]}`;
        bigrams.set(key, (bigrams.get(key) ?? 0) + 1);
      }
      // a hyphen with text after it on the same line was never a line break
      for (const m of text.matchAll(/([A-Za-z\u00C0-\u024F]{2,})[-\u2010]([A-Za-z\u00C0-\u024F]{2,})/g)) {
        hyphenated.add(`${m[1]!.toLowerCase()}-${m[2]!.toLowerCase()}`);
      }
    }
  }
  return { hyphenated, words, bigrams };
}

export function joinerFor(prevRaw: string, nextRaw: string, lex?: Lexicon): string {
  // A recovered line can carry trailing space after its break hyphen; the
  // break is the same break either way.
  const prev = prevRaw.replace(/\s+$/, "");
  const next = nextRaw.replace(/^\s+/, "");
  if (/[-\u2010]$/.test(prev) && /^[a-z]/.test(next)) {
    if (!lex) return "";
    const a = /([A-Za-z\u00C0-\u024F]+)[-\u2010]$/.exec(prev)?.[1]?.toLowerCase();
    const b = /^([a-z\u00C0-\u024F]+)/.exec(next)?.[1]?.toLowerCase();
    if (!a || !b) return "";
    if (lex.hyphenated.has(`${a}-${b}`)) return "-";
    return "";
  }
  if (!/^[a-z]/.test(next)) return " ";
  const tail = /([A-Za-z’']+)$/.exec(prev)?.[1];
  if (!tail) return " ";
  const bare = tail.toLowerCase().replace(/[’']/g, "");
  if (bare.length <= 2 && !SHORT_WORDS.has(bare)) return "";
  // a continuation that is itself a bare fragment ("oo.", "ely,") after a full
  // word is normal prose, so only the tail is evidence.
  return " ";
}

/** Drops the soft-break hyphen from the end of a run list. */
function stripSoftBreak(runs: Run[], joiner: string): Run[] {
  if (joiner !== "" && joiner !== "-") return runs;
  const out = runs.map((r) => ({ ...r }));
  const last = out[out.length - 1];
  if (last) last.t = last.t.replace(/[-\u2010]\s*$/, "");
  return out;
}


// ---------------------------------------------------------------------------
// Embedded semantic structures
// ---------------------------------------------------------------------------

const BULLET = /^\s*([•·‣▪*]|[-–—]\s)/;
const ENUM = /^\s*\(?([0-9]{1,2}|[a-z]|[ivxIVX]{1,4})[.)]\s+\S/;

interface Geom {
  size: number;
  left: number;
  right: number;
}

function geomOf(b: Block): Geom | null {
  const boxes = b.prov?.boxes ?? [];
  if (!boxes.length) return null;
  const sizes = boxes.map((x) => x.h).sort((a, b2) => a - b2);
  return {
    size: sizes[Math.floor(sizes.length / 2)] ?? 0,
    left: Math.min(...boxes.map((x) => x.x)),
    right: Math.max(...boxes.map((x) => x.x + x.w)),
  };
}

/**
 * Recognize regions the book sets apart from running prose: an inserted letter,
 * a block quotation, a list.
 *
 * The evidence is regional, never per line: a *run* of paragraphs set smaller
 * than the body, or inset from both margins, is an embedded region. A single
 * short raised span is a superscript and is handled far upstream — a multi-line
 * region never is. Nothing here knows any book: a letter is recognised by the
 * shape a letter has (an inset region closing with a short signature line), not
 * by its wording.
 */
export function classifyEmbedded(blocks: Block[], profile: DocProfile, structure: StructureNode[] = []): void {
  const width = Math.max(80, profile.maxRight - profile.proseLeft);
  // An apparatus is routinely set smaller than the body; that is the note list's
  // ordinary measure, not an embedded quotation, so those sections are left to
  // the apparatus detector.
  const byId = new Map(structure.map((s) => [s.id, s]));
  const apparatusSection = (id: string): boolean => {
    let cur = byId.get(id);
    while (cur) {
      if (cur.type === "apparatus" || cur.type === "appendix") return true;
      cur = cur.parent ? byId.get(cur.parent) : undefined;
    }
    return false;
  };
  const eligible = (b: Block) => !apparatusSection(b.section);

  // lists first: a run of paragraphs each opening with a bullet or enumerator
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i]!;
    if (b.type !== "paragraph") continue;
    const marked = (x: Block) =>
      x.type === "paragraph" && eligible(x) && (BULLET.test(x.text) || ENUM.test(x.text));
    if (!marked(b)) continue;
    let j = i;
    while (j < blocks.length && marked(blocks[j]!)) j++;
    if (j - i >= 2) {
      const gid = `grp-list-${b.id}`;
      for (let k = i; k < j; k++) {
        const x = blocks[k]!;
        x.type = "list-item";
        x.group = gid;
        if (k === i) x.groupEdge = "start";
        else if (k === j - 1) x.groupEdge = "end";
        else delete x.groupEdge;
        x.groupWhy = `${j - i} consecutive paragraphs open with a list marker`;
      }
    }
    i = j - 1;
  }

  // inset / smaller regions
  const inset = (b: Block): { why: string; strong: boolean } | null => {
    if (b.type !== "paragraph" || !eligible(b)) return null;
    const g = geomOf(b);
    if (!g) return null;
    const smaller = profile.bodySize > 0 && g.size > 0 && g.size <= profile.bodySize * 0.93;
    const insetLeft = g.left > profile.proseLeft + width * 0.04;
    const insetRight = g.right < profile.maxRight - width * 0.04;
    if (smaller) {
      return {
        why: `set at ${g.size.toFixed(1)}pt against a ${profile.bodySize.toFixed(1)}pt body`,
        strong: insetLeft || insetRight,
      };
    }
    if (insetLeft && insetRight) return { why: "inset from both margins", strong: true };
    return null;
  };

  for (let i = 0; i < blocks.length; i++) {
    if (!inset(blocks[i]!)) continue;
    let j = i;
    const whys: string[] = [];
    while (j < blocks.length) {
      const hit = inset(blocks[j]!);
      if (!hit) break;
      whys.push(hit.why);
      j++;
    }
    const region = blocks.slice(i, j);
    // one lone paragraph in a smaller face is a colophon, a credit line, a
    // caption — not a quotation. An embedded region either runs to several
    // paragraphs or is unmistakably inset from both margins.
    if (region.length && (region.length >= 2 || inset(region[0]!)?.strong)) {
      // an embedded document (a letter, a notice) closes with a short line set
      // apart from the region's own measure — a signature or a dateline
      const last = region[region.length - 1]!;
      const lastGeom = geomOf(last);
      const regionLeft = Math.min(...region.map((b) => geomOf(b)?.left ?? Infinity));
      const tail = last.text.trim();
      // a source citation — "(11.409–20)", "— Iliad 2.5" — closes a quotation,
      // never a letter; a signature is a bare name or valediction
      const citation = /^[([]/.test(tail) || /\d/.test(tail);
      const signature =
        region.length >= 2 &&
        tail.length < 70 &&
        tail.split(/\s+/).length <= 8 &&
        !citation &&
        !!lastGeom &&
        (lastGeom.left > regionLeft + width * 0.08 || /^[^a-z]+$/.test(tail.replace(/[^A-Za-z ]/g, "")));
      const type: Block["type"] = signature ? "letter" : "blockquote";
      const gid = `grp-${type}-${region[0]!.id}`;
      region.forEach((b, k) => {
        b.type = type;
        b.group = gid;
        if (region.length === 1) b.groupEdge = "only";
        else if (k === 0) b.groupEdge = "start";
        else if (k === region.length - 1) b.groupEdge = "end";
        else delete b.groupEdge;
        b.groupWhy = `${whys[k] ?? "inset region"}${signature ? "; region closes with a short signature line" : ""}`;
      });
    }
    i = j - 1;
  }
}


/**
 * Re-insert word spaces the encoder never emitted ("donot", "thegreat").
 *
 * The split is only made on the document's own evidence: the fused form must be
 * effectively unattested, both halves must be words the document uses
 * repeatedly, and the split must be unambiguous. That keeps genuine long words
 * ("notwithstanding") and proper names intact, in any language, without a
 * dictionary.
 */
export function repairGluedTokens(blocks: Block[], lex: Lexicon): string[] {
  const applied: string[] = [];
  const cache = new Map<string, string | null>();

  const split = (word: string): string | null => {
    const lower = word.toLowerCase();
    // Only a long, otherwise-unattested token is safe to split without a
    // dictionary: shorter fused spellings ("everyday", "nobleman") are ordinary
    // words that merely happen to appear once, and splitting them corrupts the
    // reading text — the cost of a false split is far higher than a missed one.
    if (word.length < 11 || word.length > 28) return null;
    if (!/^[a-z\u00C0-\u024F]+$/.test(lower)) return null;
    // the fused spelling must be effectively unattested — if the document
    // prints it repeatedly it is a word of the book, not an extraction slip
    if ((lex.words.get(lower) ?? 0) > 1) return null;
    if (cache.has(lower)) return cache.get(lower)!;
    let out: string | null = null;
    let best = 0;
    for (let i = 3; i <= lower.length - 3; i++) {
      const a = lower.slice(0, i);
      const b = lower.slice(i);
      // the only evidence accepted: the document itself prints these two words
      // side by side, with a space, several times
      const n = lex.bigrams.get(`${a} ${b}`) ?? 0;
      if (n >= 4 && n > best) {
        best = n;
        out = `${word.slice(0, i)} ${word.slice(i)}`;
      }
    }
    cache.set(lower, out);
    return out;
  };

  // The mirror case of a fused token: a word left in halves by a break hyphen
  // the extractor kept ("know- ledge"). Accepted only when the document itself
  // prints the whole word and never prints the pair as two words.
  const unsplit = (a: string, bWord: string): string | null => {
    const fused = (a + bWord).toLowerCase();
    if ((lex.words.get(fused) ?? 0) < 1) return null;
    if ((lex.bigrams.get(`${a.toLowerCase()} ${bWord.toLowerCase()}`) ?? 0) > 0) return null;
    if (lex.hyphenated.has(`${a.toLowerCase()}-${bWord.toLowerCase()}`)) return null;
    return a + bWord;
  };

  for (const b of blocks) {
    if (b.type === "verse-space") continue;
    let changed = false;
    for (const r of b.runs) {
      const before = r.t;
      r.t = r.t.replace(
        /([A-Za-z\u00C0-\u024F]{2,})[-\u2010] +([a-z\u00C0-\u024F]{2,})/g,
        (m, a: string, c: string) => {
          const fixed = unsplit(a, c);
          if (fixed) applied.push(`${m} \u2192 ${fixed}`);
          return fixed ?? m;
        },
      );
      const next = r.t.replace(/[A-Za-z\u00C0-\u024F]{7,}/g, (w) => {
        const fixed = split(w);
        if (fixed) applied.push(`${w} \u2192 ${fixed}`);
        return fixed ?? w;
      });
      r.t = next;
      if (next !== before) changed = true;
    }
    if (changed) {
      b.text = b.runs
        .map((r) => r.t)
        .join("")
        .replace(/\s+/g, " ")
        .trim();
    }
  }
  return applied;
}
