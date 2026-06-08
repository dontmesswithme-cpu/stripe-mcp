import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { logger } from "../../utils/logger.js";

const __filename = fileURLToPath(import.meta.url);

let worker: Worker | null = null;
let messageIdCounter = 0;
const pendingRequests = new Map<number, { resolve: (val: any) => void; reject: (err: Error) => void }>();

export function getDbWorker(): Worker {
  if (!worker) {
    const workerFile = __filename.replace("db.client", "db.worker");
    
    // In vitest/tsx environment with ESM, passing a .ts file to Worker
    // might require the loader. We can pass execArgv if we detect .ts extension.
    const execArgv = workerFile.endsWith(".ts") && !process.execArgv.some(arg => arg.includes("loader"))
      ? ["--import", "tsx"]
      : process.execArgv;
      
    const currentWorker = new Worker(workerFile, { execArgv });
    worker = currentWorker;

    currentWorker.on("message", (msg: { id: number; result?: any; error?: string; ok: boolean }) => {
      const { id, result, error, ok } = msg;
      const req = pendingRequests.get(id);
      if (req) {
        pendingRequests.delete(id);
        if (ok) {
          req.resolve(result);
        } else {
          req.reject(new Error(error));
        }
      }
    });

    const handleCrash = (reason: any) => {
      if (worker !== currentWorker) return; // Ignore if this is an old worker emitting exit after error
      logger.error({ reason }, "DB worker crashed or stopped unexpectedly");
      for (const req of pendingRequests.values()) {
        req.reject(new Error("Worker crashed"));
      }
      pendingRequests.clear();
      worker = null;
    };

    currentWorker.on("error", handleCrash);

    currentWorker.on("exit", (code) => {
      if (code !== 0) {
        handleCrash(code);
      }
    });
  }
  return worker;
}

export function runDbOp<T>(method: string, ...args: any[]): Promise<T> {
  const id = ++messageIdCounter;
  
  const workerPromise = new Promise<T>((resolve, reject) => {
    pendingRequests.set(id, { resolve, reject });
    getDbWorker().postMessage({ id, method, args });
  });

  let timeoutId: NodeJS.Timeout;
  const timeoutPromise = new Promise<T>((_, reject) => {
    timeoutId = setTimeout(() => {
      pendingRequests.delete(id);
      getDbWorker().postMessage({ type: "cancel", cancelId: id });
      reject(new Error(`DB operation timeout: ${method}`));
    }, 15000);
  });

  return Promise.race([workerPromise, timeoutPromise]).finally(() => {
    clearTimeout(timeoutId);
  });
}

export async function shutdownDbWorker(): Promise<void> {
  if (worker) {
    await runDbOp("closeAllDatabases");
    await worker.terminate();
    worker = null;
  }
}
