import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Regression guard for "Wasm code generation disallowed by embedder" and every
// earlier import crash of the same family. The hosted server cannot compile
// WebAssembly, so no code reachable from the server may start a PDF or OCR
// engine. Reading the PDF happens in the browser (src/lib/ingest); the server
// only analyses stored JSON. This walks the real import graph — static and
// dynamic — from every server entry point and fails if an engine is reachable.

const SRC = resolve(__dirname, "..");
const ROOT = resolve(SRC, "..");

/** Packages and modules that start a WebAssembly engine or pdf.js. */
const ENGINE_PACKAGES = ["pdfjs-dist", "tesseract-wasm", "@embedpdf/pdfium", "unpdf", "mupdf"];
const ENGINE_CODE = /\bWebAssembly\s*\.\s*(instantiate|compile|Module|Instance)\b/;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|js|mjs)$/.test(name)) out.push(p);
  }
  return out;
}

const all = walk(SRC);

/** Every module the server can start from. */
const entries = all.filter(
  (f) =>
    /\.(server|functions)\.tsx?$/.test(f) ||
    f.startsWith(join(SRC, "routes", "api")) ||
    /src\/(start|server|router)\.tsx?$/.test(f),
);

function resolveLocal(from: string, spec: string): string | null {
  const base = spec.startsWith("@/") ? join(SRC, spec.slice(2)) : resolve(dirname(from), spec);
  for (const c of [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, join(base, "index.ts")]) {
    if (existsSync(c) && statSync(c).isFile()) return c;
  }
  return null;
}

/** Runtime imports only: `import type` and `export type` vanish at build time. */
function importsOf(code: string): string[] {
  const specs: string[] = [];
  const re =
    /(?:^|\n)\s*(?:import|export)\s+(?!type\b)(?:[^'"]*?\sfrom\s+)?["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;
  for (let m; (m = re.exec(code)); ) specs.push((m[1] ?? m[2])!);
  return specs;
}

function serverReachable() {
  const seen = new Map<string, string>(); // file -> who imported it
  const hits: string[] = [];
  const queue: [string, string][] = entries.map((e) => [e, "entry"]);
  for (let i = 0; i < queue.length; i++) {
    const [file, via] = queue[i]!;
    if (seen.has(file)) continue;
    seen.set(file, via);
    const code = readFileSync(file, "utf8");
    if (ENGINE_CODE.test(code) && !file.endsWith(".test.ts")) hits.push(`${file} compiles WebAssembly (via ${via})`);
    for (const spec of importsOf(code)) {
      if (ENGINE_PACKAGES.some((p) => spec === p || spec.startsWith(`${p}/`))) {
        hits.push(`${file} imports ${spec} (via ${via})`);
        continue;
      }
      if (spec.startsWith(".") || spec.startsWith("@/")) {
        const target = resolveLocal(file, spec);
        if (target) queue.push([target, file]);
      }
    }
  }
  return { seen, hits };
}

describe("server never starts a reading engine", () => {
  it("finds the server entry points", () => {
    expect(entries.some((f) => f.endsWith("import.functions.ts"))).toBe(true);
    expect(entries.some((f) => f.endsWith("import-run.server.ts"))).toBe(true);
  });

  it("no engine package or WebAssembly compile is reachable from server code", () => {
    const { hits } = serverReachable();
    expect(hits.map((h) => h.replace(`${ROOT}/`, ""))).toEqual([]);
  });

  it("the browser engine modules are not reachable from server code", () => {
    // run.ts / protocol.ts only post messages to the worker and store results;
    // they are allowed in the page's server-rendered graph. The worker and
    // every module that drives an engine are not.
    const engineModules = [
      "lib/ingest/ingest.worker.ts",
      "lib/ingest/pdfjs.ts",
      "lib/ingest/tesseract.ts",
      "lib/ingest/ocr-page.ts",
      "lib/ingest/assets.ts",
      "lib/source/pdfium.ts",
      "lib/source/glyph-ocr.ts",
      "lib/source/extract.ts",
      "lib/source/vendor/pdfium-web.js",
    ];
    const { seen } = serverReachable();
    const leaked = [...seen.keys()].filter((f) => engineModules.some((m) => f.endsWith(m)));
    expect(leaked).toEqual([]);
  });

  it("the guard actually detects an engine import", () => {
    expect(importsOf('const { init } = await import("tesseract-wasm");')).toContain("tesseract-wasm");
    expect(importsOf('import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";')).toContain(
      "pdfjs-dist/legacy/build/pdf.mjs",
    );
    expect(importsOf('import type { X } from "pdfjs-dist";')).toEqual([]);
    expect(ENGINE_CODE.test("await WebAssembly.instantiate(bytes)")).toBe(true);
  });
});

describe("engine binaries served to the browser match the installed packages", () => {
  const require = createRequire(import.meta.url);
  const sha = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");
  const pairs: [string, string][] = [
    ["pdfium.wasm", require.resolve("@embedpdf/pdfium/pdfium.wasm")],
    ["tesseract-core.wasm", join(dirname(require.resolve("tesseract-wasm")), "tesseract-core.wasm")],
  ];
  for (const [name, pkg] of pairs) {
    it(`public/engines/${name} is the packaged copy`, () => {
      expect(sha(join(ROOT, "public", "engines", name))).toBe(sha(pkg));
    });
  }
  it("the OCR language model is present", () => {
    expect(statSync(join(ROOT, "public", "engines", "eng.traineddata")).size).toBeGreaterThan(1_000_000);
  });
});
