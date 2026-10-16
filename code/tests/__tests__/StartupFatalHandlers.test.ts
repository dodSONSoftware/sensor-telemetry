/*
 * Copyright (c) 2026 dodson Software ( dodson labs )
 * SPDX-License-Identifier: MIT
 */

import * as fs from "fs";
import * as path from "path";

// Regression coverage for the fatal-handler registration order in
// src/index.ts. The uncaughtException / unhandledRejection handlers must be
// registered BEFORE the MqttNetworking construction (which creates the MQTT
// client and the PrometheusWriter): a synchronous throw from that
// construction (a future mqtt.connect failure mode the config schema does
// not validate away) rejects the startup IIFE, and a rejection surfacing
// before the handlers are registered terminates the process through Node's
// default unhandled-rejection path — a raw stack dump with no structured
// fatal log and no exit-code ownership.
//
// The throw cannot be reproduced in a subprocess today (the schema
// validates away every known synchronous-throw form of the constructor
// inputs, so the real entrypoint never reaches that path), so the invariant
// is pinned directly on the source: the registration must precede the
// construction, and shutdown() must tolerate the not-yet-constructed
// networking instead of hitting a TDZ reference.
describe("index.ts fatal handler registration order (regression)", () => {
  const src = fs.readFileSync(
    path.resolve(__dirname, "..", "..", "src", "index.ts"),
    "utf8"
  );

  it("registers the fatal process handlers before constructing MqttNetworking", () => {
    const construction = src.indexOf("new MqttNetworking(");
    expect(construction).toBeGreaterThanOrEqual(0);
    for (const handler of ["uncaughtException", "unhandledRejection"]) {
      const registration = src.indexOf(`process.on("${handler}"`);
      expect(registration).toBeGreaterThanOrEqual(0);
      expect(registration).toBeLessThan(construction);
    }
  });

  it("guards the shutdown close call against an unconstructed networking", () => {
    // A fatal error landing in the construction window must route through
    // shutdown() and still terminate: the close call must skip, not
    // reference, an unassigned networking.
    expect(src).toContain("networking?.close(");
  });
});

// Regression coverage for the /restart-service dispatch in src/index.ts.
// The HTTP layer (PrometheusWriter) may REQUEST a restart but must never
// own process lifecycle: index.ts owns the callback, and the callback must
// self-signal SIGTERM so the existing graceful-shutdown path (cleanup,
// exit-code ownership, audit markers) runs exactly as for an operator
// `docker stop` — never a direct process.exit (would skip the MQTT
// disconnect and the Loki flush) and never a Docker call (the container
// has no Docker socket/CLI by design). The callback is registered through
// the SIGTERM handler, which the ordering test above already pins to be
// in place before the MqttNetworking construction that receives it.
describe("index.ts /restart-service dispatch (regression)", () => {
  const src = fs.readFileSync(
    path.resolve(__dirname, "..", "..", "src", "index.ts"),
    "utf8"
  );

  it("reuses the SIGTERM graceful path via a self-signal, not process.exit", () => {
    expect(src).toContain('process.on("SIGTERM"');
    expect(src).toContain('process.kill(process.pid, "SIGTERM")');
    // The callback body (const declaration through its closing brace —
    // comments above it are excluded on purpose) must be a thin
    // self-signal: no direct exit in the restart path; the exit is owned
    // by shutdown()'s finally block.
    const cbStart = src.indexOf("const requestRestart");
    expect(cbStart).toBeGreaterThanOrEqual(0);
    const callback = src.slice(cbStart, src.indexOf("};", cbStart));
    expect(callback).toContain('process.kill(process.pid, "SIGTERM")');
    expect(callback).not.toContain("process.exit");
  });

  it("passes the restart callback into the MqttNetworking construction", () => {
    const construction = src.slice(src.indexOf("new MqttNetworking("), src.indexOf("new MqttNetworking(") + 200);
    expect(construction).toContain("requestRestart");
  });
});
