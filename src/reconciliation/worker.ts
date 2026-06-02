/**
 * @module reconciliation/worker
 *
 * Reconciles unknown execution outcomes via Stripe idempotent replay.
 */

import { config } from "../config.js";
import {
  findUnknownOutcomes,
  sweepStaleExecutions,
  updateExecutionStatus,
  recordReconcileAttempt,
} from "../execution/store.js";
import {
  canReplayExecution,
  replayStripeMutation,
} from "./replay.js";

/**
 * Sweeps stale executing rows, then resolves unknown_outcome executions.
 */
export async function runReconciliationCycle(): Promise<void> {
  const swept = sweepStaleExecutions();
  if (swept > 0) {
    console.error(
      `[RECONCILIATION] Marked ${swept} stale executing row(s) as unknown_outcome`,
    );
  }

  await reconcileUnknownOutcomes();
}

export async function reconcileUnknownOutcomes(): Promise<void> {
  const unknownExecutions = findUnknownOutcomes();
  if (unknownExecutions.length === 0) return;

  const retryIntervalMs = config.reconciliationRetryIntervalMs;
  const maxAgeMs = config.reconciliationMaxAgeHours * 60 * 60 * 1000;
  const now = Date.now();

  for (const execution of unknownExecutions) {
    try {
      const ageMs = now - new Date(execution.startedAt).getTime();

      if (ageMs > maxAgeMs) {
        console.error(
          `[RECONCILIATION] execution ${execution.executionId} -> cancelled (age > ${config.reconciliationMaxAgeHours}h)`,
        );
        updateExecutionStatus(execution.executionId, "cancelled");
        continue;
      }

      if (execution.lastReconcileAt !== null) {
        const sinceLast = now - new Date(execution.lastReconcileAt).getTime();
        if (sinceLast < retryIntervalMs) {
          continue;
        }
      }

      recordReconcileAttempt(execution.executionId);

      if (!canReplayExecution(execution)) {
        continue;
      }

      const result = await replayStripeMutation(execution);

      if (result.status === "completed") {
        updateExecutionStatus(execution.executionId, "completed", {
          stripeObjectId: result.stripeObjectId,
        });
        console.error(
          `[RECONCILIATION] execution ${execution.executionId} -> completed (idempotent replay)`,
        );
      } else if (result.status === "failed_terminal") {
        updateExecutionStatus(execution.executionId, "failed_terminal");
        console.error(
          `[RECONCILIATION] execution ${execution.executionId} -> failed_terminal (replay)`,
        );
      }
    } catch (error) {
      console.error(
        `[RECONCILIATION] Failed to reconcile execution ${execution.executionId}`,
        error,
      );
    }
  }
}
