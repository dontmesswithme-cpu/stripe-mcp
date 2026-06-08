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

// ── LRU Cache ───────────────────────────────────────────────────────

class LRUCache<T> {
  private cache = new Map<string, { value: T; expiresAt: number }>();
  private sweepInterval: NodeJS.Timeout;
  
  constructor(private maxItems: number, private ttlMs: number) {
    this.sweepInterval = setInterval(() => this.sweep(), Math.min(ttlMs, 60000));
    if (this.sweepInterval.unref) {
      this.sweepInterval.unref();
    }
  }

  private sweep(): void {
    const now = Date.now();
    for (const [key, item] of this.cache.entries()) {
      if (now > item.expiresAt) {
        this.cache.delete(key);
      }
    }
  }

  get(key: string): T | undefined {
    const item = this.cache.get(key);
    if (!item) return undefined;
    if (Date.now() > item.expiresAt) {
      this.cache.delete(key);
      return undefined;
    }
    this.cache.delete(key);
    this.cache.set(key, item);
    return item.value;
  }

  set(key: string, value: T): void {
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= this.maxItems) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey !== undefined) {
          this.cache.delete(oldestKey);
      }
    }
    this.cache.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }
}

const customerCache = new LRUCache<Stripe.Customer | Stripe.DeletedCustomer>(1000, 10 * 60 * 1000);
const refundStatsCache = new LRUCache<{ total: number; refunded: number }>(1000, 10 * 60 * 1000);

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
    await checkVelocity(context, factors);
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
async function checkVelocity(
  context: OperationContext,
  factors: RiskFactor[],
): Promise<void> {
  if (context.customerId === undefined) return;

  const now = Date.now();
  const since24h = new Date(now - 24 * 60 * 60 * 1000).toISOString();
  const since30d = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString();

  const count24h = await countRecentOperations(
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

  const count30d = await countRecentOperations(
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
    let result = customerCache.get(context.customerId);
    if (!result) {
      result = await stripe.customers.retrieve(context.customerId);
      customerCache.set(context.customerId, result);
    }
    // Deleted customers can't be scored further
    if ("deleted" in result && result.deleted) return;
    customer = result as Stripe.Customer;
  } catch (error: any) {
    if (
      error?.statusCode === 429 ||
      (error?.statusCode && error.statusCode >= 500) ||
      error?.type === "StripeRateLimitError" ||
      error?.type === "StripeAPIError" ||
      error?.type === "StripeConnectionError"
    ) {
      throw new Error("Service Unavailable");
    }
    // Customer lookup failed — enforce fail-closed policy
    factors.push({
      name: "risk_evaluation_failure",
      description: "Failed to evaluate customer risk factors due to API error",
      points: config.riskBlockThreshold,
    });
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
    let stats = refundStatsCache.get(customerId);
    if (!stats) {
      let total = 0;
      let refunded = 0;
      for await (const charge of stripe.charges.list({ customer: customerId })) {
        total++;
        if (charge.refunded || charge.amount_refunded > 0) {
          refunded++;
        }
      }
      stats = { total, refunded };
      refundStatsCache.set(customerId, stats);
    }

    if (stats.total === 0) return;

    const ratio = stats.refunded / stats.total;
    if (ratio > 0.3) {
      factors.push({
        name: "high_refund_ratio",
        description:
          `Refund ratio ${(ratio * 100).toFixed(0)}% ` +
          `(${stats.refunded}/${stats.total} charges refunded)`,
        points: 15,
      });
    }
  } catch (error: any) {
    if (
      error?.statusCode === 429 ||
      (error?.statusCode && error.statusCode >= 500) ||
      error?.type === "StripeRateLimitError" ||
      error?.type === "StripeAPIError" ||
      error?.type === "StripeConnectionError"
    ) {
      throw new Error("Service Unavailable");
    }
    // Charge lookup failed — enforce fail-closed policy
    factors.push({
      name: "risk_evaluation_failure",
      description: "Failed to evaluate refund ratio due to API error",
      points: config.riskBlockThreshold,
    });
  }
}
