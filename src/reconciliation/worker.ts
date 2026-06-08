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
import { logger } from "../utils/logger.js";

/**
 * Sweeps stale executing rows, then resolves unknown_outcome executions.
 */
export async function runReconciliationCycle(): Promise<void> {
  const swept = await sweepStaleExecutions();
  if (swept > 0) {
    logger.warn(
      { sweptCount: swept },
      "Marked stale executing row(s) as unknown_outcome"
    );
  }

  await reconcileUnknownOutcomes();
}

export async function reconcileUnknownOutcomes(): Promise<void> {
  const unknownExecutions = await findUnknownOutcomes();
  if (unknownExecutions.length === 0) return;

  const retryIntervalMs = config.reconciliationRetryIntervalMs;
  const maxAgeMs = config.reconciliationMaxAgeHours * 60 * 60 * 1000;
  const now = Date.now();

  for (const execution of unknownExecutions) {
    try {
      const ageMs = now - new Date(execution.startedAt).getTime();

      if (ageMs > maxAgeMs) {
        logger.warn(
          { executionId: execution.executionId, ageMs, maxAgeMs },
          "execution cancelled (age > max)"
        );
        await updateExecutionStatus(execution.executionId, "cancelled");
        continue;
      }

      if (execution.lastReconcileAt !== null) {
        const sinceLast = now - new Date(execution.lastReconcileAt).getTime();
        if (sinceLast < retryIntervalMs) {
          continue;
        }
      }

      await recordReconcileAttempt(execution.executionId);

      if (!canReplayExecution(execution)) {
        continue;
      }

      const result = await replayStripeMutation(execution);

      if (result.status === "completed") {
        await updateExecutionStatus(execution.executionId, "completed", {
          stripeObjectId: result.stripeObjectId,
        });
        logger.info(
          { executionId: execution.executionId, stripeObjectId: result.stripeObjectId },
          "execution completed (idempotent replay)"
        );
      } else if (result.status === "failed_terminal") {
        await updateExecutionStatus(execution.executionId, "failed_terminal");
        logger.error(
          { executionId: execution.executionId },
          "execution failed_terminal (replay)"
        );
      }
    } catch (error) {
      logger.error(
        { executionId: execution.executionId, error: error instanceof Error ? error.message : String(error) },
        "Failed to reconcile execution"
      );
    }
  }
}
