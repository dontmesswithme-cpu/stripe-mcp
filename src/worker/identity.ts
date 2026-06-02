import { randomUUID } from "node:crypto";
import { hostname } from "node:os";

/**
 * Worker identity must contain:
 * - hostname
 * - process id
 * - worker uuid
 */
export const WORKER_ID = {
  hostname: hostname(),
  pid: process.pid,
  uuid: randomUUID(),
};
