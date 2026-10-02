/*
 * Copyright (c) 2026 dodson Software ( dodson labs )
 * SPDX-License-Identifier: MIT
 */

import { Logger } from "../../../src/dodsonlabs/Logger";
import {
  LOG_BOUND_MAX_DEPTH,
  LOG_BOUND_DEPTH_MARKER,
} from "../../../src/dodsonlabs/SystemFunctions";
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

describe("Logger printf-token messages keep structured metadata", () => {
  const baseConfig: z.infer<typeof configSchema> = {
    logLevel: "info",
    apiPort: 3301,
    mqttBrokerIpAddress: "10.0.0.1",
    mqttTopicTelemetry: "iot/v3/telemetry",
  };

  /**
   * Regression guard: when the message carries a winston printf token,
   * the three-argument log(level, message, metadata) form routed the
   * metadata through the SPLAT path and the JSON record lost it. Every
   * test here asserts the message stays literal AND the structured fields
   * survive.
   */
  async function captureRecord(
    level: "info" | "warn" | "error",
    originator: string,
    message: string,
    metadata?: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const out = await captureLogOutput(() => {
      const logger = new Logger(baseConfig);
      // Call through the instance (not a detached method reference), so
      // the write_* path keeps its `this`.
      if (level === "warn") {
        logger.write_warn(originator, message, metadata);
      } else if (level === "error") {
        logger.write_error(originator, message, metadata);
      } else {
        logger.write_info(originator, message, metadata);
      }
    });
    return parseSingleLogLine(out);
  }

  function parseSingleLogLine(out: string): Record<string, unknown> {
    const line = out.trim().split("\n").pop();
    if (!line) {
      throw new Error(`no log line captured (output: ${JSON.stringify(out)})`);
    }
    return JSON.parse(line);
  }

  it("keeps all structured metadata for a message containing %s", async () => {
    const record = await captureRecord(
      "info",
      "module/function",
      "Sanitized source 'a%sb'",
      { event: "evt", source: "sensor-1" },
    );

    // The message is a literal string, not a printf template: nothing is
    // interpolated into it.
    expect(record.message).toBe("Sanitized source 'a%sb'");
    expect(record.level).toBe("info");
    expect(record.event).toBe("evt");
    expect(record.source).toBe("sensor-1");
    expect(record.module).toBe("module");
    expect(record.function).toBe("function");
    expect(record.logType).toBe("service");
  });

  it("keeps structured metadata for a forwarded-log-shaped message containing %d", async () => {
    const record = await captureRecord(
      "info",
      "networking/logInfo",
      '[sensor-1] {"body":"value=%d"}',
      {
        event: "evt",
        logType: "sensor",
        source: "sensor-1",
        module: "firmware",
        version: undefined,
      },
    );

    expect(record.message).toBe('[sensor-1] {"body":"value=%d"}');
    expect(record.level).toBe("info");
    expect(record.event).toBe("evt");
    expect(record.source).toBe("sensor-1");
    expect(record.module).toBe("firmware");
    expect(record.logType).toBe("sensor");
    // version: undefined intentionally suppresses the defaultMeta version
    // for forwarded sensor logs; it must stay suppressed.
    expect(record.version).toBeUndefined();
  });

  it("keeps structured metadata for a message containing %%", async () => {
    const record = await captureRecord(
      "warn",
      "module/function",
      "humidity at 100%% of range",
      { event: "evt", source: "sensor-2" },
    );

    expect(record.message).toBe("humidity at 100%% of range");
    expect(record.level).toBe("warn");
    expect(record.event).toBe("evt");
    expect(record.source).toBe("sensor-2");
    expect(record.module).toBe("module");
    expect(record.function).toBe("function");
    expect(record.logType).toBe("service");
  });

  it("produces the same effective fields as before for a token-free message", async () => {
    const record = await captureRecord(
      "info",
      "module/function",
      "an ordinary message",
      { event: "evt", source: "sensor-3" },
    );

    expect(record.message).toBe("an ordinary message");
    expect(record.level).toBe("info");
    expect(record.event).toBe("evt");
    expect(record.source).toBe("sensor-3");
    expect(record.module).toBe("module");
    expect(record.function).toBe("function");
    expect(record.logType).toBe("service");
    // defaultMeta merging is unchanged: service metadata is applied first
    // and visible unless overridden.
    expect(record.service).toBe("sensor-telemetry");
    expect(typeof record.version).toBe("string");
    expect(record.environment).toBe(process.env.NODE_ENV ?? "development");
  });
});

describe("Logger deep untrusted metadata (regression P2-1)", () => {
  const baseConfig: z.infer<typeof configSchema> = {
    logLevel: "info",
    apiPort: 3301,
    mqttBrokerIpAddress: "10.0.0.1",
    mqttTopicTelemetry: "iot/v3/telemetry",
  };

  /** One log call -> one single-line JSON record (the chain ends in json()). */
  function parseRecord(out: string): Record<string, unknown> {
    const line = out.trim().split("\n").pop();
    if (!line) {
      throw new Error(`no log line captured (output: ${JSON.stringify(out)})`);
    }
    return JSON.parse(line);
  }

  it("completes on a deeply nested array without RangeError, still redacting, bounded at the depth cap", async () => {
    // 500 nesting levels: the redaction pass used to recurse unbounded, so
    // an arbitrary MQTT-supplied structure could exhaust the call stack per
    // log line.
    let deep: unknown = { leaf: "bottom" };
    for (let i = 0; i < 500; i++) deep = [deep];

    let record: Record<string, unknown>;
    const out = await captureLogOutput(() => {
      const logger = new Logger(baseConfig);
      logger.write_error("test/deepMetadata", "deep untrusted metadata", {
        event: "deep_metadata",
        logType: "sensor",
        password: "hunter2",
        nested: deep,
      });
    });

    // The pipeline completed and emitted a parseable record (no throw).
    record = parseRecord(out);
    expect(record.event).toBe("deep_metadata");

    // Secret redaction still applies to shallow fields.
    expect(record.password).toBe("[REDACTED]");

    // The nested structure terminates in the bounded depth marker after a
    // few array levels — not 500.
    let current: unknown = record.nested;
    let arrayLevels = 0;
    while (Array.isArray(current)) {
      current = current[0];
      arrayLevels++;
      expect(arrayLevels).toBeLessThanOrEqual(LOG_BOUND_MAX_DEPTH);
    }
    expect(current).toBe(LOG_BOUND_DEPTH_MARKER);
    expect(out).toContain(LOG_BOUND_DEPTH_MARKER);
  });

  it("bounds a deeply nested object the same way", async () => {
    let deepObject: Record<string, unknown> = { leaf: "bottom" };
    for (let i = 0; i < 500; i++) deepObject = { child: deepObject };

    let record: Record<string, unknown>;
    const out = await captureLogOutput(() => {
      const logger = new Logger(baseConfig);
      logger.write_warn("test/deepObject", "deep untrusted object", {
        event: "deep_object",
        logType: "sensor",
        detail: deepObject,
      });
    });

    record = parseRecord(out);
    expect(record.event).toBe("deep_object");

    let current: unknown = record.detail;
    let levels = 0;
    while (
      current !== null &&
      typeof current === "object" &&
      !Array.isArray(current) &&
      "child" in (current as Record<string, unknown>)
    ) {
      current = (current as Record<string, unknown>).child;
      levels++;
      expect(levels).toBeLessThanOrEqual(LOG_BOUND_MAX_DEPTH);
    }
    expect(current).toBe(LOG_BOUND_DEPTH_MARKER);
  });

  it("keeps Error fields serializable at any depth", async () => {
    // Error handling must survive the depth cap unchanged: the stack
    // survives into the record (bounded by construction), not flattened.
    let record: Record<string, unknown>;
    const out = await captureLogOutput(() => {
      const logger = new Logger(baseConfig);
      logger.write_error("test/errorDepth", "failure", {
        event: "error_depth",
        error: new Error("boom"),
      });
    });

    record = parseRecord(out);
    const error = record.error as { message?: string; stack?: string };
    expect(error.message).toBe("boom");
    expect(error.stack).toContain("boom");
  });
});
