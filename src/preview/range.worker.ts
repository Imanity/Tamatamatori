import { rangeWorker } from "./range-worker.ts";
import type { RangeMessage, RangeReply } from "./range-worker.ts";

// Module worker for "推算 · 两者都找": many days of DEM line solving off the main thread.
const scope = self as unknown as { onmessage: ((event: MessageEvent<RangeMessage>) => void) | null; postMessage(reply: RangeReply): void };
const handle = rangeWorker((reply) => scope.postMessage(reply));
scope.onmessage = (event) => handle(event.data);
