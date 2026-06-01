/**
 * @module approval/server
 *
 * HTTP server for the approval workflow.
 *
 * Endpoints:
 *   GET  /approvals/:token          → Retrieve token status
 *   POST /approvals/:token/approve  → Approve a pending token
 *   POST /approvals/:token/reject   → Reject a pending token
 *
 * Uses `node:http` (stdlib) — no Express dependency. Runs on a
 * configurable port (default 3001). Set `APPROVAL_PORT=0` to disable.
 *
 * All output to stderr. Stdout is reserved for MCP protocol.
 */

import { createServer, type Server } from "node:http";
import { config } from "../config.js";
import { getApproval, approveToken, rejectToken } from "./store.js";

// ── UUID v4 pattern for path matching ───────────────────────────────

const UUID_PATTERN =
  /^\/approvals\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?(.*)$/;

// ── Public API ──────────────────────────────────────────────────────

/**
 * Start the approval HTTP server.
 *
 * @description Listens on `config.approvalPort`. If the port is 0,
 *   the server is not started and a message is logged to stderr.
 * @returns The `http.Server` instance, or `null` if disabled.
 */
export function startApprovalServer(): Server | null {
  if (config.approvalPort === 0) {
    console.error("stripe-mcp: approval server disabled (APPROVAL_PORT=0)");
    return null;
  }

  const server = createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");

    // ── Parse path ──────────────────────────────────────────────
    const match = (req.url ?? "").match(UUID_PATTERN);
    if (!match) {
      res.writeHead(404);
      res.end(JSON.stringify({ error: "Not found. Use /approvals/{token}" }));
      return;
    }

    const token = match[1]!;
    const action = match[2] ?? "";

    // ── GET /approvals/:token ───────────────────────────────────
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

    // ── POST /approvals/:token/approve ──────────────────────────
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

    // ── POST /approvals/:token/reject ───────────────────────────
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

    // ── Fallback ────────────────────────────────────────────────
    res.writeHead(405);
    res.end(
      JSON.stringify({
        error: "Method not allowed. GET to check status, POST .../approve or .../reject",
      }),
    );
  });

  server.listen(config.approvalPort, () => {
    console.error(
      `stripe-mcp: approval server listening on http://localhost:${config.approvalPort}`,
    );
  });

  return server;
}
