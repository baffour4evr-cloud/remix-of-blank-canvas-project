import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { init } from "./vendor/pdfium-web.js";

// Regression guard for "Cannot read properties of undefined (reading 'startsWith')".
// The hosted server bundle has no `import.meta.url` but does look like Node, which
// sent the package's default build down a path that dereferenced it. The vendored
// web build must never read the module location and must start under Node.

// code only: strip comments so the explanatory header does not count
const vendored = readFileSync(new URL("./vendor/pdfium-web.js", import.meta.url), "utf8")
  .split("\n")
  .filter((l) => !l.trim().startsWith("//"))
  .join("\n");
const require = createRequire(import.meta.url);
const wasm = new Uint8Array(readFileSync(require.resolve("@embedpdf/pdfium/pdfium.wasm")));

describe("vendored PDFium engine", () => {
  it("never reads its own module location", () => {
    expect(vendored).not.toMatch(/import\.meta/);
  });

  it("has no Node-detection branch that could run on the server", () => {
    expect(vendored).not.toMatch(/createRequire|fileURLToPath/);
  });

  it("starts in a Node-like environment from supplied bytes", async () => {
    expect(typeof process.versions.node).toBe("string");
    const m = await init({ wasmBinary: wasm as unknown as ArrayBufferView });
    m.PDFiumExt_Init();
    // a blank one-page document round-trips through the engine
    const doc = m.FPDF_CreateNewDocument();
    m.FPDFPage_New(doc, 0, 200, 100);
    expect(m.FPDF_GetPageCount(doc)).toBe(1);
    m.FPDF_CloseDocument(doc);
  });
});
