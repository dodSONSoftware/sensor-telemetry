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
