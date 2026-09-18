/**
 * @module approval/server
 *
 * HTTP server for the approval workflow.
 */

import { createServer, type Server } from "node:http";
import { timingSafeEqual, createHash } from "node:crypto";
import { config } from "../config.js";
import { getApproval, approveToken, rejectToken } from "./store.js";
import { logger } from "../utils/logger.js";

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let activeServer: Server | null = null;
let bindSettled: Promise<boolean> | null = null;

export function bearerMatches(provided: string, expectedHashHex: string): boolean {
  const prefix = "Bearer ";
  if (!provided.startsWith(prefix)) return false;
  const token = provided.slice(prefix.length);
  const a = createHash("sha256").update(token).digest();
  const b = Buffer.from(expectedHashHex, "hex");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Resolve once the approval server has either bound its port or failed to.
 * Resolves true when listening, false when the bind failed / server was
 * never started. Safe to await multiple times.
 */
export function whenApprovalServerReady(): Promise<boolean> {
  return bindSettled ?? Promise.resolve(false);
}

/**
 * Start the approval HTTP server (synchronous, never throws).
 *
 * Bind failures (e.g. EADDRINUSE) are async — they surface via the
 * server's "error" handler, not via a sync return. The sync return is the
 * server object for lifecycle management; callers that need to know whether
 * the bind succeeded should check `isApprovalServerActive()` (or wait for
 * the "listening" event), since `activeServer` is assigned only inside the
 * "listening" callback and cleared to null on "error".
 */
export function startApprovalServer(): Server | null {
  if (config.approvalPort === 0) {
    logger.warn("approval server disabled (APPROVAL_PORT=0)");
    return null;
  }

  if (!config.approvalApiHash) {
    logger.warn("approval server disabled (APPROVAL_API_KEY not set)");
    return null;
  }

  const server = createServer(async (req, res) => {
    res.setHeader("Content-Type", "application/json");

    const parsedUrl = new URL(req.url ?? "", "http://localhost");
    const pathParts = parsedUrl.pathname.split("/").filter(Boolean);

    if (pathParts[0] !== "approvals" || !pathParts[1] || !UUID_REGEX.test(pathParts[1])) {
      res.writeHead(404);
      res.end(JSON.stringify({ error: "Not found. Use /approvals/{token}" }));
      return;
    }

    const token = pathParts[1];
    const action = pathParts[2] ?? "";

    const authHeader = req.headers.authorization;
    if (
      !authHeader ||
      !bearerMatches(authHeader, config.approvalApiHash)
    ) {
      res.writeHead(401);
      res.end(JSON.stringify({ error: "Unauthorized. Provide Bearer token." }));
      return;
    }

    if (req.method === "GET" && action === "") {
      const approval = await getApproval(token);
      if (approval === null) {
        res.writeHead(404);
        res.end(JSON.stringify({ error: "Token not found" }));
        return;
      }
      res.writeHead(200);
      res.end(JSON.stringify(approval, null, 2));
      return;
    }

    if (req.method === "POST" && action === "approve") {
      const approverHeader = req.headers["x-approver"];
      const decidedBy =
        (Array.isArray(approverHeader) ? approverHeader[0] : approverHeader)?.trim() ||
        "admin";
      const approval = await approveToken(token, decidedBy);
      if (approval === null) {
        res.writeHead(404);
        res.end(
          JSON.stringify({
            error: "Token not found, not pending, or already expired",
          }),
        );
        return;
      }
      logger.info({ token }, "approval APPROVED");
      res.writeHead(200);
      res.end(JSON.stringify(approval, null, 2));
      return;
    }

    if (req.method === "POST" && action === "reject") {
      const approverHeader = req.headers["x-approver"];
      const decidedBy =
        (Array.isArray(approverHeader) ? approverHeader[0] : approverHeader)?.trim() ||
        "admin";
      const approval = await rejectToken(token, decidedBy);
      if (approval === null) {
        res.writeHead(404);
        res.end(
          JSON.stringify({
            error: "Token not found, not pending, or already expired",
          }),
        );
        return;
      }
      logger.info({ token }, "approval REJECTED");
      res.writeHead(200);
      res.end(JSON.stringify(approval, null, 2));
      return;
    }

    res.writeHead(405);
    res.end(
      JSON.stringify({
        error: "Method not allowed. GET to check status, POST .../approve or .../reject",
      }),
    );
  });

  server.on("error", (err) => {
    logger.error(
      { err, port: config.approvalPort },
      "approval server failed to start, approvals disabled",
    );
    if (activeServer === server) {
      activeServer = null;
    }
  });

  bindSettled = new Promise<boolean>((resolve) => {
    server.once("listening", () => resolve(true));
    server.once("error", () => resolve(false));
  });

  server.listen(config.approvalPort, "127.0.0.1", () => {
    activeServer = server;
    logger.info(
      { port: config.approvalPort },
      "approval server listening"
    );
  });

  return server;
}

export function isApprovalServerActive(): boolean {
  return activeServer !== null;
}

export function stopApprovalServer(): Promise<void> {
  const server = activeServer;
  activeServer = null;
  if (server === null) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    server.close((err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}
