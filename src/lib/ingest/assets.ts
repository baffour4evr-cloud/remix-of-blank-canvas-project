// Engine binaries, served as static files from /engines/ and fetched once per
// worker. They are copies of the files shipped inside the installed packages;
// server-engines.test.ts fails if a package update leaves them out of date.

import type { OcrAssets } from "./tesseract";

/** Throws if the bytes are not what the file name promises. */
export function assertEngineBytes(name: string, bytes: Uint8Array): void {
  if (name.endsWith(".wasm")) {
    const isWasm = bytes[0] === 0x00 && bytes[1] === 0x61 && bytes[2] === 0x73 && bytes[3] === 0x6d;
    if (!isWasm) {
      const head = new TextDecoder().decode(bytes.subarray(0, 24)).replace(/\s+/g, " ");
      throw new Error(
        `the reading engine file ${name} is not a WebAssembly module (${bytes.length} bytes, starts with "${head}"). It is probably missing from /engines/ and the host served a web page instead.`,
      );
    }
  }
  if (name.endsWith(".traineddata") && bytes.length < 1_000_000) {
    throw new Error(`the language model ${name} is too small (${bytes.length} bytes) — it is missing or truncated.`);
  }
}

async function fetchBytes(name: string): Promise<Uint8Array> {
  const url = new URL(`/engines/${name}`, self.location.origin);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`could not load the reading engine (${name}): HTTP ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  assertEngineBytes(name, bytes);
  return bytes;
}

let pdfium: Promise<Uint8Array> | null = null;
let ocr: Promise<OcrAssets> | null = null;

export const engineAssets = {
  pdfium: () => (pdfium ??= fetchBytes("pdfium.wasm")),
  ocr: () =>
    (ocr ??= Promise.all([fetchBytes("tesseract-core.wasm"), fetchBytes("eng.traineddata")]).then(
      ([wasm, model]) => ({ wasm, model }),
    )),
};
