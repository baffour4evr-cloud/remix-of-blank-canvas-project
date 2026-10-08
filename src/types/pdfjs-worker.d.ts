// The worker build ships no typings; it is only ever used for its
// WorkerMessageHandler export on the server.
declare module "pdfjs-dist/legacy/build/pdf.worker.mjs" {
  export const WorkerMessageHandler: unknown;
}
