import pino from "pino";

// Since stdout is reserved for the MCP protocol, all structured logging
// must be directed to stderr.
export const logger = pino(
  {
    level: process.env.LOG_LEVEL || "info",
    base: {
      pid: process.pid,
    },
    timestamp: pino.stdTimeFunctions.isoTime,
  },
  pino.destination(2)
);
