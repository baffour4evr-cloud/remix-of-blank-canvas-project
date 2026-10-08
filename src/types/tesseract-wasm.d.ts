// The package ships typings that its "exports" map does not expose.
declare module "tesseract-wasm" {
  export interface IntRect {
    left: number;
    top: number;
    right: number;
    bottom: number;
  }
  export interface TextItem {
    rect: IntRect;
    flags: number;
    confidence: number;
    text: string;
  }
  export interface OCREngine {
    loadModel(model: Uint8Array | ArrayBuffer): void;
    loadImage(image: { data: Uint8Array | Uint8ClampedArray; width: number; height: number }): void;
    getTextBoxes(unit: "word" | "line", onProgress?: (p: number) => void): TextItem[];
    getText(onProgress?: (p: number) => void): string;
    clearImage(): void;
    destroy(): void;
  }
  export function createOCREngine(options?: {
    wasmBinary?: Uint8Array | ArrayBuffer;
    emscriptenModuleOptions?: unknown;
  }): Promise<OCREngine>;
  export const layoutFlags: { StartOfLine: number; EndOfLine: number };
}
