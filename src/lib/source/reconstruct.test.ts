/**
 * Reconstruction tests.
 *
 * Every fixture is synthetic and generic: no document, title, page or phrase is
 * ever special-cased, here or in the implementation. The central property under
 * test is that characters the file decoded survive reconstruction byte for byte.
 */

import { describe, expect, it } from "vitest";
import { mappingGroups, reconstruct } from "./reconstruct";
import type { FontRef, SourceChar, SourceDoc, SourceLink, SourcePage, SourceRun } from "./types";

let nextChar = 0;

function font(psName: string, over: Partial<FontRef> & { smallCapFlag?: boolean; fixedPitch?: boolean } = {}) {
  const f = {
    id: psName,
    handle: psName,
    psName,
    family: psName,
    subset: null,
    subtype: null,
    flags: { bold: false, italic: false, black: false, vertical: false, type3: false, missingFile: false },
    hasEmbeddedProgram: true,
    ascent: null,
    descent: null,
    bbox: null,
    smallCapFlag: false,
    fixedPitch: false,
    ...over,
  };
  f.flags = { ...f.flags, ...(over.flags ?? {}) };
  return f as FontRef;
}

function run(text: string, fontId: string, over: Partial<SourceRun> = {}): SourceRun {
  const size = over.size ?? 10;
  const chars: SourceChar[] = [...text].map((ch, k) => ({
    i: nextChar++,
    ch,
    code: ch.codePointAt(0) ?? 0,
    gid: null,
    fontChar: null,
    accent: null,
    isSpaceGlyph: ch === " ",
    inFont: true,
    advance: size * 0.5,
    origin: { x: 50 + k * size * 0.5, y: 700 },
    bbox: { x: 50 + k * size * 0.5, y: 700, w: size * 0.5, h: size },
    geometry: "glyph-advance",
    unicodeSource: "engine-mapped",
    fontId,
    size,
    run: over.order ?? 0,
    link: null,
  }));
  return {
    order: chars[0]?.i ?? 0,
    fontId,
    size,
    text,
    chars,
    bbox: { x: 50, y: 700, w: text.length * size * 0.5, h: size },
    origin: { x: 50, y: 700 },
    hasEOL: true,
    width: text.length * size * 0.5,
    ...over,
  };
}

function doc(runs: SourceRun[], fonts: FontRef[], links: SourceLink[] = []): SourceDoc {
  const page: SourcePage = {
    page: 1,
    width: 612,
    height: 792,
    rotation: 0,
    runs,
    links,
    images: [],
    method: "native",
  };
  return {
    version: 1,
    producer: "test",
    pageCount: 1,
    meta: { title: null, author: null, info: {} },
    outline: [],
    fonts: Object.fromEntries(fonts.map((f) => [f.id, f])),
    pages: [page],
  };
}

function texts(source: SourceDoc): string[] {
  return reconstruct(source).pages[0]!.items.map((i) => i.t);
}

const serif = font("Serif");

describe("character preservation", () => {
  const cases: [string, string][] = [
    ["ordinary prose", "It is a truth universally acknowledged."],
    ["an uppercase heading", "CHAPTER 1"],
    ["a roman numeral heading", "VOLUME I"],
    ["mixed case", "Pride and Prejudice"],
    ["lowercase", "the morning after"],
    ["plain numbers", "1974 1975 2040"],
    ["a number in brackets", "[6]"],
    ["a reference range", "(1.136-40)"],
    ["punctuation only", "— , ; : ! ?"],
    ["curly quotes", "\u201cDesign! nonsense\u201d"],
    ["a precomposed accent", "na\u00efve"],
    ["a decomposed accent", "nai\u0308ve"],
    ["stacked diacritics", "\u1e2f"],
    ["non-Latin script", "\u0391\u03c1\u03c7\u03ae \u0448\u0440\u0438\u0444\u0442"],
    ["an em dash between words", "one—two"],
    ["double spaces", "a  b"],
  ];
  for (const [name, text] of cases) {
    it(`preserves ${name}`, () => {
      const items = reconstruct(doc([run(text, serif.id)], [serif])).pages[0]!.items;
      expect(items.map((i) => i.t0).join("")).toBe(text);
      expect(items.map((i) => i.t).join("")).toBe(text.normalize("NFC"));
      expect(items.every((i) => !i.unmapped)).toBe(true);
    });
  }

  it("keeps a ligature's own characters in the raw evidence", () => {
    const items = reconstruct(doc([run("\ufb01nal", serif.id)], [serif])).pages[0]!.items;
    // the raw evidence is exactly what the file encoded ...
    expect(items[0]!.t0).toBe("\ufb01nal");
    // ... and the reading text only ever applies the app's canonical
    // decomposition of typographic ligatures, never a substitution rule.
    expect(items[0]!.t).toBe("final");
  });

  it("never rewrites text because another font in the document is broken", () => {
    const broken = font("Display");
    const source = doc(
      [run("CHAPTER 1", serif.id), run("\u0000\u0000\u0000", broken.id, { order: 100 })],
      [serif, broken],
    );
    expect(texts(source)[0]).toBe("CHAPTER 1");
  });

  it("never rewrites text because most of its own font is broken", () => {
    const f = font("Mixed");
    const source = doc(
      [
        run("\u0000\u0000\u0000\u0000\u0000\u0000\u0000\u0000\u0000\u0000", f.id),
        run("legible", f.id, { order: 50 }),
      ],
      [f],
    );
    expect(texts(source)).toContain("legible");
  });
});

describe("typography is metadata, never a change of letters", () => {
  it("records small caps as a flag and leaves the letters alone", () => {
    const sc = font("Serif-SmallCaps", { smallCapFlag: true });
    const items = reconstruct(doc([run("VOLUME I", sc.id)], [sc])).pages[0]!.items;
    expect(items[0]!.t).toBe("VOLUME I");
    expect(items[0]!.sc).toBe(true);
  });

  it("does not claim small caps for an ordinary font", () => {
    const items = reconstruct(doc([run("Volume I", serif.id)], [serif])).pages[0]!.items;
    expect(items[0]!.sc).toBeUndefined();
  });

  it("reads italic and bold from the font's own flags", () => {
    const it_ = font("Serif-Italic", { flags: { italic: true } as FontRef["flags"] });
    const bold = font("Serif-Bold", { flags: { bold: true } as FontRef["flags"] });
    const source = doc([run("may", it_.id), run("Note", bold.id, { order: 10 })], [it_, bold]);
    const items = reconstruct(source).pages[0]!.items;
    expect(items[0]).toMatchObject({ t: "may", em: true });
    expect(items[0]!.strong).toBeUndefined();
    expect(items[1]).toMatchObject({ t: "Note", strong: true });
    expect(items[1]!.em).toBeUndefined();
  });

  it("keeps fonts distinguishable on the reconstructed spans", () => {
    const a = font("A");
    const b = font("B");
    const items = reconstruct(doc([run("one", a.id), run("two", b.id, { order: 9 })], [a, b])).pages[0]!.items;
    expect(items.map((i) => i.f)).toEqual(["A", "B"]);
  });
});

describe("undecodable glyphs", () => {
  it("marks a span with no mapping as uncertain instead of guessing", () => {
    const f = font("Display");
    const items = reconstruct(doc([run("\u0000\u0000\u0000\u0000", f.id)], [f])).pages[0]!.items;
    expect(items[0]!.unmapped).toBe(4);
    expect(items[0]!.uncertain).toBe(true);
    expect(items[0]!.t0).toBe("\u0000\u0000\u0000\u0000");
  });

  it("splits a span where mapping availability changes", () => {
    const f = font("Mixed");
    const items = reconstruct(doc([run("\u0000\u0000 was born", f.id)], [f])).pages[0]!.items;
    expect(items).toHaveLength(2);
    expect(items[0]!.unmapped).toBe(2);
    expect(items[1]!.t).toBe(" was born");
    expect(items[1]!.unmapped).toBeUndefined();
  });

  it("keeps whitespace inside an undecodable span with that span", () => {
    const groups = mappingGroups(run("\u0000\u0000 \u0000\u0000 ok", "f").chars);
    expect(groups.map((g) => g.map((c) => c.ch).join(""))).toEqual(["\u0000\u0000 \u0000\u0000", " ok"]);
  });

  it("gives every span a stable character-order identity", () => {
    const f = font("Mixed");
    const items = reconstruct(doc([run("\u0000\u0000 fine", f.id)], [f])).pages[0]!.items;
    expect(items[0]!.o).toBeTypeOf("number");
    expect(items[1]!.o).toBeGreaterThan(items[0]!.o!);
  });
});

describe("geometry and provenance", () => {
  it("keeps position, width, size and font on every span", () => {
    const item = reconstruct(doc([run("text", serif.id)], [serif])).pages[0]!.items[0]!;
    expect(item.x).toBe(50);
    expect(item.y).toBe(700);
    expect(item.w).toBeGreaterThan(0);
    expect(item.s).toBe(10);
    expect(item.f).toBe("Serif");
    expect(item.fam).toBe("Serif");
  });

  it("carries page size, count and metadata through unchanged", () => {
    const source = doc([run("text", serif.id)], [serif]);
    source.meta.title = "A Title";
    source.meta.author = "An Author";
    const raw = reconstruct(source);
    expect(raw.pageCount).toBe(1);
    expect(raw.meta).toEqual({ title: "A Title", author: "An Author" });
    expect(raw.pages[0]).toMatchObject({ width: 612, height: 792, method: "native" });
  });

  it("keeps a link associated with the characters it covers", () => {
    const r = run("see [6] there", serif.id);
    const marker = r.chars.slice(4, 7);
    const link: SourceLink = {
      id: "l1",
      rect: { x: marker[0]!.bbox!.x, y: 700, w: 15, h: 10 },
      url: null,
      destPage: 40,
      destY: 120,
      charRange: { start: marker[0]!.i, end: marker[2]!.i + 1 },
      overlaidText: null,
    };
    const raw = reconstruct(doc([r], [serif], [link]));
    expect(raw.pages[0]!.links[0]).toMatchObject({ destPage: 40, destY: 120, text: "[6]" });
  });

  it("reports an empty page as empty rather than inventing content", () => {
    const raw = reconstruct(doc([], [serif]));
    expect(raw.pages[0]!.items).toEqual([]);
    expect(raw.pages[0]!.method).toBe("empty");
  });
});
