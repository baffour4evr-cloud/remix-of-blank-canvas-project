import { describe, expect, it } from "vitest";
import { pageRasterReport } from "./pdfjs";

const PAINT_IMAGE_XOBJECT = 85;

function fakePage(objs: Record<string, unknown>, names: string[]) {
  const store = {
    has: (n: string) => n in objs,
    get: (n: string, cb?: (o: unknown) => void) => {
      if (cb) {
        cb(objs[n]);
        return undefined;
      }
      return objs[n];
    },
  };
  return {
    getViewport: () => ({ width: 100, height: 200 }),
    getOperatorList: async () => ({
      fnArray: names.map(() => PAINT_IMAGE_XOBJECT),
      argsArray: names.map((n) => [n]),
    }),
    objs: store,
    commonObjs: store,
  };
}

describe("pageRasterReport", () => {
  it("reports a page with no image operations as having none", async () => {
    const r = await pageRasterReport(fakePage({}, []));
    expect(r.raster).toBeNull();
    expect(r.imageOps).toBe(0);
  });
  it("decodes an RGB image object", async () => {
    const data = new Uint8Array(2 * 2 * 3).fill(200);
    const r = await pageRasterReport(fakePage({ im: { width: 2, height: 2, kind: 2, data } }, ["im"]));
    expect(r.raster?.width).toBe(2);
    expect(r.raster?.data.length).toBe(16);
  });
  it("reports an image with no pixels as undecodable, not blank", async () => {
    const r = await pageRasterReport(fakePage({ im: { width: 10, height: 10 } }, ["im"]));
    expect(r.raster).toBeNull();
    expect(r.imageOps).toBe(1);
    expect(r.undecodable.length).toBe(1);
  });
});
