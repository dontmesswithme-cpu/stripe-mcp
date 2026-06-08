import { parentPort } from "node:worker_threads";
import { initializeAllDatabases, closeAllDatabases, getApprovalsDb } from "../../utils/db.js";
import * as auditLog from "../../audit/log.worker.js";
import * as approvalStore from "../../approval/store.worker.js";
import * as executionStore from "../../execution/store.worker.js";
import * as pruneLog from "../../audit/prune.worker.js";

const handlers: Record<string, Function> = {
  initializeAllDatabases,
  closeAllDatabases,
  writeAuditEntry: auditLog.writeAuditEntry,
  queryAuditLog: auditLog.queryAuditLog,
  countRecentOperations: auditLog.countRecentOperations,
  createApproval: approvalStore.createApproval,
  getApproval: approvalStore.getApproval,
  approveToken: approvalStore.approveToken,
  rejectToken: approvalStore.rejectToken,
  consumeApproval: approvalStore.consumeApproval,
  createExecution: executionStore.createExecution,
  beginExecution: executionStore.beginExecution,
  getExecution: executionStore.getExecution,
  updateExecutionStatus: executionStore.updateExecutionStatus,
  recordReconcileAttempt: executionStore.recordReconcileAttempt,
  findUnknownOutcomes: executionStore.findUnknownOutcomes,
  sweepStaleExecutions: executionStore.sweepStaleExecutions,
  pruneAuditLog: pruneLog.pruneAuditLog,
  testQuery: (sql: string, ...params: any[]) => {
    const stmt = getApprovalsDb().prepare(sql);
    return stmt.reader ? stmt.all(...params) : stmt.run(...params);
  },
};

import { AsyncLocalStorage } from "node:async_hooks";

export const executionContext = new AsyncLocalStorage<{ isCancelled: () => boolean }>();
const cancelledOps = new Set<number>();

if (!parentPort) {
  throw new Error("db.worker.ts must be run as a worker thread");
}

parentPort.on("message", async (msg: any) => {
  if (msg.type === "cancel") {
    cancelledOps.add(msg.cancelId);
    return;
  }

  const { id, method, args } = msg;
  if (!id || !method) return;

  if (cancelledOps.has(id)) {
    cancelledOps.delete(id);
    parentPort!.postMessage({ id, error: "Operation cancelled", ok: false });
    return;
  }

  try {
    const handler = handlers[method];
    if (!handler) {
      throw new Error(`Unknown DB worker method: ${method}`);
    }

    const ctx = {
      isCancelled: () => cancelledOps.has(id),
    };

    const result = await executionContext.run(ctx, () => handler(...args));

    if (cancelledOps.has(id)) {
      cancelledOps.delete(id);
      parentPort!.postMessage({ id, error: "Operation cancelled during execution", ok: false });
      return;
    }

    parentPort!.postMessage({ id, result, ok: true });
  } catch (error) {
    if (cancelledOps.has(id)) {
      cancelledOps.delete(id);
    }
    parentPort!.postMessage({ id, error: error instanceof Error ? error.message : String(error), ok: false });
  }
});
