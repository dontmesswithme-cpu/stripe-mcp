import { runDbOp } from "../worker/db/db.client.js";
import type { BeginExecutionFailureReason, BeginExecutionResult } from "./store.worker.js";
import type {
  ExecutionRecord,
  ExecutionReconcileContext,
  ExecutionStatus,
} from "../types.js";
import type Database from "better-sqlite3";

export { BeginExecutionFailureReason, BeginExecutionResult };

export async function createExecution(
  approvalToken: string | null,
  requestHash: string,
  idempotencyKey: string,
  workerId: { hostname: string; pid: number; uuid: string },
  reconcile: ExecutionReconcileContext,
  db?: Database.Database,
): Promise<ExecutionRecord> {
  if (db) throw new Error("Cannot pass local db to worker");
  return runDbOp("createExecution", approvalToken, requestHash, idempotencyKey, workerId, reconcile);
}

export async function beginExecution(
  approvalToken: string | null,
  requestHash: string,
  idempotencyKey: string,
  workerId: { hostname: string; pid: number; uuid: string },
  reconcile: ExecutionReconcileContext,
): Promise<BeginExecutionResult> {
  return runDbOp("beginExecution", approvalToken, requestHash, idempotencyKey, workerId, reconcile);
}

export async function getExecution(executionId: string): Promise<ExecutionRecord | null> {
  return runDbOp("getExecution", executionId);
}

export async function updateExecutionStatus(
  executionId: string,
  status: ExecutionStatus,
  metadata?: {
    stripeObjectId?: string | null;
    lastError?: Record<string, unknown> | null;
  },
): Promise<void> {
  return runDbOp("updateExecutionStatus", executionId, status, metadata);
}

export async function recordReconcileAttempt(executionId: string): Promise<void> {
  return runDbOp("recordReconcileAttempt", executionId);
}

export async function findUnknownOutcomes(): Promise<ExecutionRecord[]> {
  return runDbOp("findUnknownOutcomes");
}

export async function sweepStaleExecutions(): Promise<number> {
  return runDbOp("sweepStaleExecutions");
}
