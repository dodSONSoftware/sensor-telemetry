/*
 * Copyright (c) 2026 dodson Software ( dodson labs )
 * SPDX-License-Identifier: MIT
 */

import { Logger } from "../../../src/dodsonlabs/Logger";
import type { configSchema } from "../../../src/schemas/config";
import type { z } from "zod";

/**
 * Capture what winston's Console transport writes, returning the written
 * text as one joined string.
 *
 * fn must construct the Logger and perform the log calls, because the
 * Console transport binds the console methods at construction time and the
 * Winston Logger pipeline is asynchronous. The helper re-spies the console
 * methods (which jest.setup has already silenced, and which the transport
 * is forced onto since jest.setup clears the `console._stdout` /
 * `console._stderr` streams) and awaits the pipeline to flush before
 * restoring them.
 */
async function captureLogOutput(fn: () => void): Promise<string> {
  const chunks: string[] = [];
  const capture = (...data: unknown[]) => {
    for (const item of data) {
      if (item !== undefined && item !== null) {
        chunks.push(String(item));
      }
    }
  };

  const consoleSpies = (["log", "warn", "error"] as const).map((method) =>
    jest.spyOn(console, method).mockImplementation(capture as never),
  );

  try {
    fn();
    // Allow the winston pipeline (Logger stream -> transport) to flush.
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    for (const spy of consoleSpies) {
      spy.mockRestore();
    }
  }
  return chunks.join("");
}

describe("Logger log level handling", () => {
  const baseConfig: z.infer<typeof configSchema> = {
    logLevel: "info",
    apiPort: 3301,
    mqttBrokerIpAddress: "10.0.0.1",
    mqttTopicTelemetry: "iot/v3/telemetry",
  };

  it("honors logLevel 'critical' at construction instead of falling back to info", () => {
    const logger = new Logger({ ...baseConfig, logLevel: "critical" });
    expect(logger.global_log_level_string()).not.toBe("info");
    expect(logger.global_log_level_string()).toBe("critical");
  });

  it("filters at the winston error level when constructed with critical", async () => {
    const out = await captureLogOutput(() => {
      const logger = new Logger({ ...baseConfig, logLevel: "critical" });
      logger.write_warn("test/warn", "a warn message");
      logger.write_error("test/error", "an error message");
    });
    expect(out).toContain("an error message");
    expect(out).not.toContain("a warn message");
  });

  it("accepts critical via setLogLevel and changes the effective level", async () => {
    const out = await captureLogOutput(() => {
      const logger = new Logger(baseConfig);
      const changed = logger.setLogLevel("critical");
      expect(changed).toBe(true);
      expect(logger.global_log_level_string()).toBe("critical");

      logger.write_warn("test/warn", "a warn message");
      logger.write_error("test/error", "an error message");
    });
    expect(out).toContain("an error message");
    expect(out).not.toContain("a warn message");
  });

  it("still rejects levels outside the schema and leaves the level unchanged", () => {
    const logger = new Logger(baseConfig);
    const changed = logger.setLogLevel("verbose");
    expect(changed).toBe(false);
    expect(logger.global_log_level_string()).toBe("info");
  });
});

describe("Logger error serialization and secret redaction", () => {
  const baseConfig: z.infer<typeof configSchema> = {
    logLevel: "info",
    apiPort: 3301,
    mqttBrokerIpAddress: "10.0.0.1",
    mqttTopicTelemetry: "iot/v3/telemetry",
  };

  /**
   * Parse the single JSON object the json() format emits for one log call.
   * The format chain ends in json(), which is single-line, so the captured
   * text (after stripping the transport's trailing newline) parses whole.
   */
  function parseSingleLine(out: string): Record<string, unknown> {
    return JSON.parse(out.trim());
  }

  it("preserves the stack trace on a write_error error: field without breaking redaction", async () => {
    let record: Record<string, unknown>;
    const out = await captureLogOutput(() => {
      const logger = new Logger(baseConfig);
      logger.write_error("test/errorSerialization", "operation failed", {
        event: "error_serialization",
        logType: "service",
        password: "hunter2",
        error: new Error("boom in foo"),
      });
    });

    // Regression guard for P2-1: the Error must not be flattened to {}.
    expect(out).not.toContain('"error":{}');

    record = parseSingleLine(out);
    const error = record.error as { name?: string; message?: string; stack?: string };

    expect(error).toBeDefined();
    expect(error.name).toBe("Error");
    expect(error.message).toBe("boom in foo");
    expect(typeof error.stack).toBe("string");
    expect(error.stack).toContain("boom in foo");
    // A real stack trace carries at least one "at " frame, not just the
    // "Error: <message>" first line.
    expect(error.stack).toMatch(/at /);

    // Redaction of sibling secret fields is unaffected by the Error handling.
    expect(record.password).toBe("[REDACTED]");
  });

  it("preserves the stack trace on a write_critical error: field", async () => {
    let record: Record<string, unknown>;
    const out = await captureLogOutput(() => {
      const logger = new Logger(baseConfig);
      logger.write_critical("test/criticalSerialization", "fatal async failure", {
        event: "unhandled_rejection",
        logType: "service",
        severity: "critical",
        fatal: true,
        exitCode: 1,
        error: new Error("async rejection detail"),
      });
    });

    expect(out).not.toContain('"error":{}');

    record = parseSingleLine(out);
    const error = record.error as { name?: string; message?: string; stack?: string };

    expect(error).toBeDefined();
    expect(error.message).toBe("async rejection detail");
    expect(typeof error.stack).toBe("string");
    expect(error.stack).toContain("async rejection detail");
    expect(error.stack).toMatch(/at /);
  });
});
