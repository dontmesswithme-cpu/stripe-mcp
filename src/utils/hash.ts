import { createHash } from "node:crypto";
import type { OperationContext } from "../types.js";

export function canonicalize(obj: unknown, depth = 0): unknown {
  if (depth > 10) {
    throw new Error("Validation Error: Maximum payload depth exceeded during canonicalization");
  }
  if (obj === null || typeof obj !== "object") {
    return obj;
  }
  if (Array.isArray(obj)) {
    return obj
      .map((item) => canonicalize(item, depth + 1))
      .sort((a, b) => {
        const strA = JSON.stringify(a);
        const strB = JSON.stringify(b);
        return strA < strB ? -1 : strA > strB ? 1 : 0;
      });
  }
  const keys = Object.keys(obj as Record<string, unknown>).sort();
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const value = (obj as Record<string, unknown>)[key];
    if (key === "approval_token" || value === undefined) continue;
    result[key] = canonicalize(value, depth + 1);
  }
  return result;
}

export function computeRequestHash(context: OperationContext): string {
  const { capability, params } = context;
  const canonicalParams = canonicalize(params);
  const idempotencyKey = String(params.idempotency_key ?? "");

  return createHash("sha256")
    .update(capability.tool)
    .update("|")
    .update(capability.operation)
    .update("|")
    .update(idempotencyKey)
    .update("|")
    .update(JSON.stringify(canonicalParams))
    .digest("hex");
}
