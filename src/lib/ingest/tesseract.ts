// Tesseract (WASM) engine, loaded once per browser worker. Never runs on the server.
//
// The engine needs two binary assets — the WASM core and a language model.
// Both are supplied by the caller (the import orchestrator caches them in
// storage) so this module never reaches for the network or the filesystem.

import type { OCREngine } from "tesseract-wasm";

let engine: OCREngine | null = null;
let loading: Promise<OCREngine> | null = null;

export interface OcrAssets {
  wasm: Uint8Array;
  model: Uint8Array;
}

export async function getEngine(assets: OcrAssets): Promise<OCREngine> {
  if (engine) return engine;
  if (!loading) {
    loading = (async () => {
      const { createOCREngine } = await import("tesseract-wasm");
      // Both buffers are handed to WASM, which takes ownership of them; the
      // caller's cached copies must survive for the next engine.
      const e = await createOCREngine({ wasmBinary: new Uint8Array(assets.wasm) });
      e.loadModel(new Uint8Array(assets.model));
      engine = e;
      return e;
    })();
  }
  return loading;
}
