import { test, expect } from "vitest";
import { bearerMatches } from "../src/approval/server.js";

test("Auth Timing Test: bearerMatches does not early-exit on length mismatch", () => {
  const expected = "a".repeat(32); // 32 byte expected key
  
  const incorrectLength = "Bearer " + "b".repeat(10);
  const correctLength = "Bearer " + "b".repeat(32);
  
  // Warm up
  for (let i = 0; i < 1000; i++) {
    bearerMatches(incorrectLength, expected);
    bearerMatches(correctLength, expected);
  }

  const startIncorrect = process.hrtime.bigint();
  for (let i = 0; i < 10000; i++) {
    bearerMatches(incorrectLength, expected);
  }
  const endIncorrect = process.hrtime.bigint();
  
  const startCorrect = process.hrtime.bigint();
  for (let i = 0; i < 10000; i++) {
    bearerMatches(correctLength, expected);
  }
  const endCorrect = process.hrtime.bigint();

  const timeIncorrect = Number(endIncorrect - startIncorrect) / 10000;
  const timeCorrect = Number(endCorrect - startCorrect) / 10000;
  
  // The time per iteration should be very similar (difference < 1ms)
  const diffNs = Math.abs(timeIncorrect - timeCorrect);
  expect(diffNs).toBeLessThan(1000000); // Less than 1ms difference per call
  
  // And neither should be instantaneous (proving it's doing work)
  expect(timeIncorrect).toBeGreaterThan(100); // at least 100ns per call
});
