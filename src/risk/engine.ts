/**
 * @module risk/engine
 *
 * Risk scoring engine for Stripe operations.
 *
 * Evaluates a set of configurable factors and produces a
 * {@link RiskScore} with an outcome of `allow`, `flag`, or `block`.
 * Every contributing signal is recorded as a {@link RiskFactor} for
 * full explainability.
 *
 * The engine is async because some factors require Stripe API lookups
 * (customer age, refund ratio, archived status). Velocity checks query
 * the local audit log via SQLite.
 */

import type Stripe from "stripe";
import { stripe } from "../stripe-client.js";
import { config } from "../config.js";
import { countRecentOperations } from "../audit/log.js";
import type {
  OperationContext,
  RiskFactor,
  RiskOutcome,
  RiskScore,
} from "../types.js";

// ── Public API ──────────────────────────────────────────────────────

/**
 * Score the risk of an operation.
 *
 * @description Evaluates all applicable risk factors for the given
 *   operation context and returns a {@link RiskScore} with the total
 *   score, derived outcome, contributing factors, and human-readable
 *   reasons.
 * @param context - The operation context describing what is about to happen.
 * @returns A {@link RiskScore} with full explainability.
 */
export async function scoreRisk(
  context: OperationContext,
): Promise<RiskScore> {
  const factors: RiskFactor[] = [];

  // ── Amount-based factors ────────────────────────────────────────
  checkAmountFactors(context, factors);

  // ── Time-of-day factor ──────────────────────────────────────────
  checkOffHours(factors);

  // ── Refund-specific factors ─────────────────────────────────────
  if (context.capability.operation === "refund") {
    checkRefundSpecificFactors(context, factors);
  }

  // ── Customer-scoped factors (require customerId) ────────────────
  if (context.customerId !== undefined) {
    checkVelocity(context, factors);
    await checkCustomerFactors(context, factors);
  }

  // ── Compute outcome ─────────────────────────────────────────────
  const total = factors.reduce((sum, f) => sum + f.points, 0);

  let outcome: RiskOutcome = "allow";
  if (total >= config.riskBlockThreshold) {
    outcome = "block";
  } else if (total >= config.riskFlagThreshold) {
    outcome = "flag";
  }

  return {
    total,
    outcome,
    factors,
    reasons: factors.map((f) => f.description),
  };
}

// ── Factor evaluators ───────────────────────────────────────────────

/** Amount thresholds — mutually exclusive (critical supersedes high). */
function checkAmountFactors(
  context: OperationContext,
  factors: RiskFactor[],
): void {
  if (context.amount === undefined) return;

  if (context.amount > config.riskAmountCritical) {
    factors.push({
      name: "very_high_amount",
      description:
        `Amount ${context.amount} exceeds critical threshold ` +
        `(${config.riskAmountCritical})`,
      points: 35,
    });
  } else if (context.amount > config.riskAmountHigh) {
    factors.push({
      name: "high_amount",
      description:
        `Amount ${context.amount} exceeds high threshold ` +
        `(${config.riskAmountHigh})`,
      points: 20,
    });
  }
}

/** Operations between 00:00–06:00 UTC. */
function checkOffHours(factors: RiskFactor[]): void {
  const utcHour = new Date().getUTCHours();
  if (utcHour < 6) {
    factors.push({
      name: "off_hours",
      description: `Operation at ${String(utcHour).padStart(2, "0")}:00 UTC (off-hours: 00:00–06:00)`,
      points: 5,
    });
  }
}

/** Refund-specific: full refund and missing reason. */
function checkRefundSpecificFactors(
  context: OperationContext,
  factors: RiskFactor[],
): void {
  const params = context.params;

  if (params["amount"] === undefined) {
    factors.push({
      name: "full_refund",
      description: "Full refund — no partial amount specified",
      points: 5,
    });
  }

  if (!params["reason"]) {
    factors.push({
      name: "no_reason",
      description: "Refund created without a reason",
      points: 5,
    });
  }
}

/** Velocity checks — 24h and 30d windows from the audit log. */
function checkVelocity(
  context: OperationContext,
  factors: RiskFactor[],
): void {
  if (context.customerId === undefined) return;

  const now = Date.now();
  const since24h = new Date(now - 24 * 60 * 60 * 1000).toISOString();
  const since30d = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString();

  const count24h = countRecentOperations(
    context.customerId,
    context.capability.operation,
    since24h,
  );

  if (count24h >= config.riskVelocity24hMax) {
    factors.push({
      name: "velocity_24h",
      description:
        `${count24h} ${context.capability.operation} operations in 24h ` +
        `(threshold: ${config.riskVelocity24hMax})`,
      points: 15,
    });
  }

  const count30d = countRecentOperations(
    context.customerId,
    context.capability.operation,
    since30d,
  );

  if (count30d >= config.riskVelocity30dMax) {
    factors.push({
      name: "velocity_30d",
      description:
        `${count30d} ${context.capability.operation} operations in 30d ` +
        `(threshold: ${config.riskVelocity30dMax})`,
      points: 10,
    });
  }
}

/**
 * Customer-scoped factors — requires a Stripe API call.
 * Checks: account age, archived status, refund ratio.
 * Errors are swallowed — a failed lookup should never block scoring.
 */
async function checkCustomerFactors(
  context: OperationContext,
  factors: RiskFactor[],
): Promise<void> {
  if (context.customerId === undefined) return;

  let customer: Stripe.Customer;
  try {
    const result = await stripe.customers.retrieve(context.customerId);
    // Deleted customers can't be scored further
    if ("deleted" in result && result.deleted) return;
    customer = result as Stripe.Customer;
  } catch {
    // Customer lookup failed — skip customer-scoped checks
    return;
  }

  // ── Account age ─────────────────────────────────────────────────
  const ageDays = (Date.now() - customer.created * 1000) / 86_400_000;
  if (ageDays < 7) {
    factors.push({
      name: "new_account",
      description: `Account created ${Math.floor(ageDays)} day(s) ago (< 7 days)`,
      points: 10,
    });
  }

  // ── Archived status ─────────────────────────────────────────────
  if (customer.metadata?.archived === "true") {
    factors.push({
      name: "archived_customer",
      description: "Customer is archived and pending deletion",
      points: 15,
    });
  }

  // ── Refund ratio (only for refund operations) ───────────────────
  if (context.capability.operation === "refund") {
    await checkRefundRatio(context.customerId, factors);
  }
}

/**
 * Approximate refund ratio using Stripe charge data.
 * Counts charges with any refund amount vs total charges.
 */
async function checkRefundRatio(
  customerId: string,
  factors: RiskFactor[],
): Promise<void> {
  try {
    const charges = await stripe.charges.list({
      customer: customerId,
      limit: 100,
    });

    if (charges.data.length === 0) return;

    const refundedCount = charges.data.filter(
      (c) => c.refunded || c.amount_refunded > 0,
    ).length;

    const ratio = refundedCount / charges.data.length;
    if (ratio > 0.3) {
      factors.push({
        name: "high_refund_ratio",
        description:
          `Refund ratio ${(ratio * 100).toFixed(0)}% ` +
          `(${refundedCount}/${charges.data.length} charges refunded)`,
        points: 15,
      });
    }
  } catch {
    // Charge lookup failed — skip this factor
  }
}
