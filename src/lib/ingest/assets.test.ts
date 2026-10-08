import { describe, expect, it } from "vitest";
import { assertEngineBytes } from "./assets";

describe("assertEngineBytes", () => {
  it("accepts a WebAssembly module", () => {
    expect(() => assertEngineBytes("x.wasm", new Uint8Array([0x00, 0x61, 0x73, 0x6d, 1, 0, 0, 0]))).not.toThrow();
  });
  it("rejects a web page served in place of a .wasm", () => {
    const html = new TextEncoder().encode("<!doctype html><html></html>");
    expect(() => assertEngineBytes("x.wasm", html)).toThrow(/not a WebAssembly module/);
  });
  it("rejects a truncated language model", () => {
    expect(() => assertEngineBytes("eng.traineddata", new Uint8Array(1000))).toThrow(/too small/);
  });
  it("accepts a plausible language model", () => {
    expect(() => assertEngineBytes("eng.traineddata", new Uint8Array(2_000_000))).not.toThrow();
  });
});
