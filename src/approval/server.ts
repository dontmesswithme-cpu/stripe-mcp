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

export function bearerMatches(provided: string, expectedHashHex: string): boolean {
  const prefix = "Bearer ";
  if (!provided.startsWith(prefix)) return false;
  const token = provided.slice(prefix.length);
  const a = createHash("sha256").update(token).digest();
  const b = Buffer.from(expectedHashHex, "hex");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

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
      const approval = await approveToken(token);
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
      const approval = await rejectToken(token);
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

  server.listen(config.approvalPort, "127.0.0.1", () => {
    logger.info(
      { port: config.approvalPort },
      "approval server listening"
    );
  });

  activeServer = server;
  return server;
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
