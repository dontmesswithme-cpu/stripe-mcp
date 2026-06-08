import { runDbOp } from "../worker/db/db.client.js";
import type { ApprovalToken, OperationContext } from "../types.js";
import type { ConsumeApprovalFailure, ConsumeApprovalResult } from "./store.worker.js";
import { canonicalize, computeRequestHash } from "../utils/hash.js";

export { ConsumeApprovalFailure, ConsumeApprovalResult, canonicalize, computeRequestHash };

export async function createApproval(
  context: OperationContext,
  riskScore: number,
): Promise<ApprovalToken> {
  return runDbOp("createApproval", context, riskScore);
}

export async function getApproval(token: string): Promise<ApprovalToken | null> {
  return runDbOp("getApproval", token);
}

export async function approveToken(
  token: string,
  decidedBy: string = "admin",
): Promise<ApprovalToken | null> {
  return runDbOp("approveToken", token, decidedBy);
}

export async function rejectToken(
  token: string,
  decidedBy: string = "admin",
): Promise<ApprovalToken | null> {
  return runDbOp("rejectToken", token, decidedBy);
}

export async function consumeApproval(
  token: string,
  requestHash: string,
): Promise<ConsumeApprovalResult> {
  return runDbOp("consumeApproval", token, requestHash);
}
