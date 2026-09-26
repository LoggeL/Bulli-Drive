// Bakes the terrain off the main thread (under a second for Bulli Bay, the
// page stays responsive on slow machines too) with the same code as the CLI
// (../logic/bakeRequest.ts → tools/map/bakeSources.ts). The sources arrive
// as the exact text the editor would export, so the result carries the
// sourceHash that `npx tsx tools/map/bake.ts` gives the exported files; for
// unchanged sources the bytes equal the committed terrain.bhf.

import { runBake, type BakeRequest, type BakeResponse } from '../logic/bakeRequest.js';

const scope = self as unknown as {
    onmessage: ((event: MessageEvent<BakeRequest>) => void) | null;
    postMessage(message: BakeResponse & { ms: number }, transfer?: Transferable[]): void;
};

scope.onmessage = event => {
    const started = performance.now();
    const response = runBake(event.data);
    const ms = performance.now() - started;
    scope.postMessage({ ...response, ms }, response.ok ? [response.bytes.buffer] : []);
};
