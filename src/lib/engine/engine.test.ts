import { expect, it } from "vitest";
import { detectFurniture } from "./furniture.ts";
import { detectVerse } from "./verse.ts";
import type { ELine, EPage, EWord } from "./types.ts";

const SIZE = 12;
function line(page: number, top: number, x: number, text: string, size = SIZE): ELine {
  const words: EWord[] = [];
  let cx = x;
  for (const t of text.split(" ")) {
    const w = t.length * size * 0.5;
    words.push({ x0: cx, x1: cx + w, top, bottom: top + size, size, text: t });
    cx += w + size * 0.25;
  }
  return { page, x, right: cx - size * 0.25, top, bottom: top + size, size, text, words };
}
const page = (n: number, lines: ELine[]): EPage => ({ page: n, width: 600, height: 800, lines });
const filler = (n: number, count = 10) =>
  Array.from({ length: count }, (_, i) => line(n, 60 + i * 18, 72, `body text of page ${n} line ${i} continues across the measure here`));

it("page numbers are recognised by sequence, including noisy OCR tokens", () => {
  const pages = Array.from({ length: 30 }, (_, i) => {
    const n = i + 1;
    const tok = n === 12 ? "10 ;" : String(n - 2);
    return page(n, [...filler(n), line(n, 740, 290, n <= 2 ? "cover" : tok)]);
  });
  const f = detectFurniture(pages);
  const nums = f.hits.filter((h) => h.kind === "page-number");
  expect(nums.length >= 27).toBeTruthy();
  expect(nums.some((h) => h.line.text === "10 ;"), "noisy token must be rescued by the sequence").toBeTruthy();
  expect(f.offsets[0]!.offset).toBe(-2);
});

it("a chapter numeral at the top of a page is not a page number", () => {
  const pages = Array.from({ length: 30 }, (_, i) => {
    const n = i + 1;
    const top = n % 10 === 1 ? [line(n, 30, 300, String(Math.floor(n / 10) + 1))] : [];
    return page(n, [...top, ...filler(n)]);
  });
  expect(detectFurniture(pages).hits.filter((h) => h.kind === "page-number").length).toBe(0);
});

it("running heads that change per chapter are caught by local repetition", () => {
  const pages = Array.from({ length: 12 }, (_, i) => {
    const n = i + 1;
    const head = n <= 6 ? "THE FIRST QUARREL" : "A NEW ACQUAINTANCE";
    return page(n, [line(n, 30, 200, head), ...filler(n)]);
  });
  expect(detectFurniture(pages).hits.filter((h) => h.kind === "running-head").length).toBe(12);
});

it("justified prose is never verse, even when scan margins drift", () => {
  const lines: ELine[] = [];
  for (let p = 1; p <= 20; p++) {
    const drift = (p * 37) % 60; // text block moves ±30 per page
    for (let i = 0; i < 30; i++) lines.push(line(p, 60 + i * 18, 72 + drift, `the quick brown fox jumps over the lazy dog and then it runs far across the field number ${i}`));
  }
  const v = detectVerse(lines, { em: SIZE, leading: 18 });
  expect(v.regions.length).toBe(0);
});

it("capitalised short lines with a counting margin sequence are numbered verse", () => {
  const lines: ELine[] = [];
  for (let i = 1; i <= 40; i++) {
    const label = i % 5 === 0 ? `${i} ` : "";
    const l = line(1 + Math.floor(i / 20), 60 + (i % 20) * 18, 100, `${label}Sing to me of the man Muse the man of twists and turns ${i}`.replace(`${i} Sing`, `${i} Sing`));
    lines.push(l);
  }
  // hang the numerals in the margin like a printed edition
  const hung = lines.map((l, idx) => {
    const n = idx + 1;
    if (n % 5 !== 0) return line(l.page, l.top, 100, `Sing to me of the man, Muse, the man of twists and turns ${n}`.replace(/ \d+$/, ""));
    const t = line(l.page, l.top, 60, `${n}`);
    const body = line(l.page, l.top, 100, "Sing to me of the man, Muse, the man of twists and turns");
    return { ...body, x: 60, words: [...t.words, ...body.words], text: `${n} ${body.text}` };
  });
  const v = detectVerse(hung, { em: SIZE, leading: 18 });
  expect(v.chains.length).toBe(1);
  expect(v.chains[0]!.step).toBe(5);
  expect(v.regions.length).toBe(1);
});

it("stray numbers in prose never become verse numbers", () => {
  const lines: ELine[] = [];
  for (let i = 0; i < 60; i++) {
    const t = i % 7 === 0 ? `${1800 + i} was the year when the quiet town first saw the railway come` : "and so the days went by in the usual way until the end of that long summer";
    lines.push(line(1 + Math.floor(i / 30), 60 + (i % 30) * 18, 72, t));
  }
  const v = detectVerse(lines, { em: SIZE, leading: 18 });
  expect(v.chains.length).toBe(0);
  expect(v.regions.length).toBe(0);
});

it("a page number with one misread digit is recovered from the sequence", () => {
  const pages = Array.from({ length: 30 }, (_, i) => {
    const n = i + 1;
    const tok = n === 20 ? "l8" : String(n - 2); // OCR read "18" as "l8"
    return page(n, [...filler(n), line(n, 740, 290, tok)]);
  });
  const f = detectFurniture(pages);
  expect(f.hits.some((h) => h.page === 20 && h.printed === 18), "misread digit must be recovered").toBeTruthy();
});

it("catalogue entries with capital line starts but no punctuation are not verse", () => {
  const titles = ["Emma by Jane Austen, read by Fiona Shaw and", "Susan Jameson", "Beowulf translated by Michael Alexander", "Agnes Grey by Anne Bronte read by Juliet Stevenson",
    "Jane Eyre by Charlotte Bronte read by Juliet Stevenson", "The Professor by Charlotte Bronte read by Juliet Stevenson", "Wuthering Heights by Emily Bronte read by Juliet Stevenson and",
    "Nigel Anthony", "Nostromo by Joseph Conrad read by Michael Pennington", "Middlemarch by George Eliot read by Harriet Walter", "Silas Marner by George Eliot read by Nigel Hawthorne",
    "Hard Times by Charles Dickens read by Timothy West", "Bleak House by Charles Dickens read by Edward Fox and", "Julia McKenzie", "Persuasion by Jane Austen read by Juliet Stevenson", "Tess of the Durbervilles by Thomas Hardy read by Eleanor Bron"];
  const lines = titles.map((t, i) => line(1, 60 + i * 18, 72, t));
  expect(detectVerse(lines, { em: SIZE, leading: 18 }).regions.length).toBe(0);
});
