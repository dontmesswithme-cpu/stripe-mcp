/**
 * @module approval/server
 *
 * HTTP server for the approval workflow.
 */

import { createServer, type Server } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { config } from "../config.js";
import { getApproval, approveToken, rejectToken } from "./store.js";

const UUID_PATTERN =
  /^\/approvals\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?(.*)$/;

let activeServer: Server | null = null;

function bearerMatches(provided: string, expected: string): boolean {
  const prefix = "Bearer ";
  if (!provided.startsWith(prefix)) return false;
  const token = provided.slice(prefix.length);
  const a = Buffer.from(token);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function startApprovalServer(): Server | null {
  if (config.approvalPort === 0) {
    console.error("stripe-mcp: approval server disabled (APPROVAL_PORT=0)");
    return null;
  }

  if (!config.approvalApiKey) {
    console.error("stripe-mcp: approval server disabled (APPROVAL_API_KEY not set)");
    return null;
  }

  const server = createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");

    const match = (req.url ?? "").match(UUID_PATTERN);
    if (!match) {
      res.writeHead(404);
      res.end(JSON.stringify({ error: "Not found. Use /approvals/{token}" }));
      return;
    }

    const token = match[1]!;
    const action = match[2] ?? "";

    const authHeader = req.headers.authorization;
    if (
      !authHeader ||
      !bearerMatches(authHeader, config.approvalApiKey)
    ) {
      res.writeHead(401);
      res.end(JSON.stringify({ error: "Unauthorized. Provide Bearer token." }));
      return;
    }

    if (req.method === "GET" && action === "") {
      const approval = getApproval(token);
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
      const approval = approveToken(token);
      if (approval === null) {
        res.writeHead(404);
        res.end(
          JSON.stringify({
            error: "Token not found, not pending, or already expired",
          }),
        );
        return;
      }
      console.error(`stripe-mcp: approval ${token} APPROVED`);
      res.writeHead(200);
      res.end(JSON.stringify(approval, null, 2));
      return;
    }

    if (req.method === "POST" && action === "reject") {
      const approval = rejectToken(token);
      if (approval === null) {
        res.writeHead(404);
        res.end(
          JSON.stringify({
            error: "Token not found, not pending, or already expired",
          }),
        );
        return;
      }
      console.error(`stripe-mcp: approval ${token} REJECTED`);
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
    console.error(
      `stripe-mcp: approval server listening on http://127.0.0.1:${config.approvalPort}`,
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
