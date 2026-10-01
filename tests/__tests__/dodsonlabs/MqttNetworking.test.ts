/*
 * Copyright (c) 2026 dodson Software ( dodson labs )
 * SPDX-License-Identifier: MIT
 */

import { MqttNetworking } from "../../../src/dodsonlabs/MqttNetworking";
import { PrometheusWriter } from "../../../src/dodsonlabs/PrometheusWriter";
import type { ILogger } from "../../../src/dodsonlabs/Interfaces";
import type { configSchema } from "../../../src/schemas/config";
import type { z } from "zod";

// Mock the mqtt client so constructing MqttNetworking never opens a real
// connection. The fake client answers the only members MqttNetworking uses:
// on (event registration), end (close callback), and connected (status).
const mockConnect = jest.fn();
jest.mock("mqtt", () => ({
  __esModule: true,
  default: {
    connect: (...args: unknown[]) => (mockConnect as jest.Mock)(...args),
  },
}));

// Auto-mock PrometheusWriter so its constructor (which starts the HTTP
// server) never runs. updateConfig does not touch the writer.
jest.mock("../../../src/dodsonlabs/PrometheusWriter");

function createMockMqttClient() {
  return {
    connected: false,
    on: jest.fn(),
    end: jest.fn((optsOrCallback?: unknown, maybeCallback?: () => void) => {
      const cb = typeof optsOrCallback === "function"
        ? (optsOrCallback as () => void)
        : maybeCallback;
      cb?.();
    }),
  };
}

// A client whose ordinary end(cb) never invokes its callback — the close
// hangs, which is exactly what the close-deadline logic has to rescue.
// Forced end(true, cb) calls back, matching the real client's force-close
// behavior (force skips waiting for pending packets and resolves).
function createHangingMqttClient() {
  return {
    connected: false,
    on: jest.fn(),
    end: jest.fn((force?: boolean, cb?: () => void) => {
      if (force) {
        cb?.();
      }
    }),
  };
}

interface MockLogger {
  global_log_level: jest.Mock;
  global_log_level_string: jest.Mock;
  write_info: jest.Mock;
  write_warn: jest.Mock;
  write_error: jest.Mock;
  write_critical: jest.Mock;
  write_debug: jest.Mock;
  setLogLevel: jest.Mock;
}

function createMockLogger(): MockLogger & ILogger {
  return {
    global_log_level: jest.fn(),
    global_log_level_string: jest.fn().mockReturnValue("info"),
    write_info: jest.fn(),
    write_warn: jest.fn(),
    write_error: jest.fn(),
    write_critical: jest.fn(),
    write_debug: jest.fn(),
    setLogLevel: jest.fn().mockReturnValue(false),
  };
}

describe("MqttNetworking.connect options", () => {
  const baseConfig: z.infer<typeof configSchema> = {
    logLevel: "info",
    apiPort: 3301,
    mqttBrokerIpAddress: "10.0.0.1",
    mqttTopicTelemetry: "iot/v3/telemetry",
    sensorSourceMaxLength: 30,
    sensorSourceValidCharsRegex: "a-zA-Z0-9._-",
  };

  beforeEach(() => {
    mockConnect.mockReset();
    mockConnect.mockReturnValue(createMockMqttClient());
  });

  it("disables the mqtt library's built-in resubscribe", () => {
    const logger = createMockLogger();
    new MqttNetworking(baseConfig, logger);

    // The app's on_connect() is the single owner of subscription: it
    // subscribes every configured topic and their SUBACKs drive the
    // subscription state /ready and the mqtt_subscription_active gauge
    // report. Leaving the library default resubscribe: true in place
    // would let the internal _resubscribe() replay on every reconnect on
    // top of the app's own subscribe calls, sending one duplicate
    // SUBSCRIBE per topic. A mocked client cannot reproduce the library's
    // internal replay (a "subscribe called once" test would pass either
    // way), so the regression guard asserts on the connect options
    // themselves.
    expect(mockConnect).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        resubscribe: false,
      }),
    );
  });
});

describe("MqttNetworking.updateConfig restart-only key warning", () => {
  const baseConfig: z.infer<typeof configSchema> = {
    logLevel: "info",
    apiPort: 3301,
    mqttBrokerIpAddress: "10.0.0.1",
    mqttTopicTelemetry: "iot/v3/telemetry",
    sensorSourceMaxLength: 30,
    sensorSourceValidCharsRegex: "a-zA-Z0-9._-",
  };

  beforeEach(() => {
    mockConnect.mockReset();
    mockConnect.mockReturnValue(createMockMqttClient());
  });

  function findRestartOnlyWarn(logger: MockLogger) {
    return logger.write_warn.mock.calls.find(
      (call) => call[2]?.event === "configuration_restart_only_keys",
    );
  }

  it("warns when sensorSourceMaxLength or sensorSourceValidCharsRegex change at runtime", () => {
    const logger = createMockLogger();
    const networking = new MqttNetworking(baseConfig, logger);

    networking.updateConfig({
      ...baseConfig,
      sensorSourceMaxLength: 40,
      sensorSourceValidCharsRegex: "a-zA-Z0-9._-+",
    });

    const warnCall = findRestartOnlyWarn(logger);
    expect(warnCall).toBeDefined();
    expect(warnCall?.[1]).toContain("sensorSourceMaxLength");
    expect(warnCall?.[1]).toContain("sensorSourceValidCharsRegex");
    expect(warnCall?.[2]).toMatchObject({
      event: "configuration_restart_only_keys",
      keys: ["sensorSourceMaxLength", "sensorSourceValidCharsRegex"],
    });
  });

  it("names only the changed sanitization key when the other is untouched", () => {
    const logger = createMockLogger();
    const networking = new MqttNetworking(baseConfig, logger);

    networking.updateConfig({ ...baseConfig, sensorSourceMaxLength: 40 });

    const warnCall = findRestartOnlyWarn(logger);
    expect(warnCall).toBeDefined();
    expect(warnCall?.[2]).toMatchObject({
      keys: ["sensorSourceMaxLength"],
    });
  });

  it("still warns for MQTT/port keys captured at construction", () => {
    const logger = createMockLogger();
    const networking = new MqttNetworking(baseConfig, logger);

    networking.updateConfig({ ...baseConfig, apiPort: 3399 });

    const warnCall = findRestartOnlyWarn(logger);
    expect(warnCall).toBeDefined();
    expect(warnCall?.[2]).toMatchObject({
      keys: ["apiPort"],
    });
  });

  it("does not warn when only runtime-effective keys change", () => {
    const logger = createMockLogger();
    const networking = new MqttNetworking(baseConfig, logger);

    networking.updateConfig({ ...baseConfig, logLevel: "debug" });

    expect(findRestartOnlyWarn(logger)).toBeUndefined();
    // The update itself is still audited.
    const infoCall = logger.write_info.mock.calls.find(
      (call) => call[2]?.event === "configuration_updated",
    );
    expect(infoCall).toBeDefined();
    expect(infoCall?.[2]).toMatchObject({ logLevel: "debug" });
  });
});

describe("MqttNetworking.close() shutdown ordering", () => {
  const baseConfig: z.infer<typeof configSchema> = {
    logLevel: "info",
    apiPort: 3301,
    mqttBrokerIpAddress: "10.0.0.1",
    mqttTopicTelemetry: "iot/v3/telemetry",
    sensorSourceMaxLength: 30,
    sensorSourceValidCharsRegex: "a-zA-Z0-9._-",
  };

  beforeEach(() => {
    mockConnect.mockReset();
    mockConnect.mockReturnValue(createMockMqttClient());
    (PrometheusWriter as unknown as jest.Mock).mockClear();
  });

  function getMockWriter() {
    return (PrometheusWriter as unknown as jest.Mock).mock.instances.at(
      -1
    ) as unknown as { close: jest.Mock };
  }

  it("does not resolve until the Prometheus server's close promise settles", async () => {
    const logger = createMockLogger();
    const mockClient = createMockMqttClient();
    mockConnect.mockReturnValue(mockClient);
    const networking = new MqttNetworking(baseConfig, logger);
    const writerMock = getMockWriter();

    // Hold the writer's close open: this is the HTTP server's connection
    // drain, and perform_close must block on it before touching the MQTT
    // client or resolving.
    let resolveWriterClose: () => void = () => {};
    writerMock.close.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveWriterClose = resolve;
      })
    );

    const closePromise = networking.close(5000);

    expect(writerMock.close).toHaveBeenCalledTimes(1);
    // The MQTT close has not started: the old fire-and-forget close()
    // would already have reached end() at this point.
    expect(mockClient.end).not.toHaveBeenCalled();

    let resolved = false;
    void closePromise.then(() => {
      resolved = true;
    });
    await Promise.resolve();
    expect(resolved).toBe(false);

    resolveWriterClose();
    await closePromise;
    expect(resolved).toBe(true);
    expect(mockClient.end).toHaveBeenCalled();
  });

  it("reuses the in-flight close instead of starting a second one", async () => {
    const logger = createMockLogger();
    const networking = new MqttNetworking(baseConfig, logger);
    const writerMock = getMockWriter();

    let resolveWriterClose: () => void = () => {};
    writerMock.close.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveWriterClose = resolve;
      })
    );

    const first = networking.close(5000);
    const second = networking.close(5000);

    expect(writerMock.close).toHaveBeenCalledTimes(1);
    resolveWriterClose();
    await Promise.all([first, second]);
    expect(writerMock.close).toHaveBeenCalledTimes(1);
  });

  it("resolves at the deadline even when the HTTP drain never finishes", async () => {
    const logger = createMockLogger();
    const mockClient = createHangingMqttClient();
    mockConnect.mockReturnValue(mockClient);
    const networking = new MqttNetworking(baseConfig, logger);
    const writerMock = getMockWriter();

    // The drain hangs forever (e.g. a stuck /write-config body). The close
    // must still settle at the deadline: close(50) means "entire shutdown
    // in ~50 ms", not "unbounded HTTP drain + 50 ms of MQTT".
    writerMock.close.mockReturnValue(new Promise<void>(() => {}));

    const startedAt = Date.now();
    await networking.close(50);
    const elapsed = Date.now() - startedAt;

    expect(elapsed).toBeLessThan(400);
    // The deadline was exhausted by the drain, so the wait was abandoned
    // with an audit error.
    const drainTimeout = logger.write_error.mock.calls.find(
      (call) => call[2]?.event === "prometheus_server_close_timeout",
    );
    expect(drainTimeout).toBeDefined();
    // The MQTT phase then ran one of two valid branches on the timing
    // boundary: the direct best-effort end(true) when the drain consumed
    // the entire deadline, or the graceful end(cb) followed by the forced
    // end(true, cb) once the remaining sliver of budget elapsed. Both are
    // correct shutdowns, so assert the invariant — a forced disconnect was
    // attempted — instead of one specific call signature, which is what
    // made this expectation flake under scheduling variance.
    expect(mockClient.end).toHaveBeenCalled();
    expect(mockClient.end.mock.calls.some((call) => call[0] === true)).toBe(true);
  });

  it("gives the MQTT close only the time the HTTP drain leaves on the deadline", async () => {
    const logger = createMockLogger();
    const mockClient = createHangingMqttClient();
    mockConnect.mockReturnValue(mockClient);
    const networking = new MqttNetworking(baseConfig, logger);
    const writerMock = getMockWriter();

    // The drain eats ~100 ms of a 200 ms deadline, leaving ~100 ms for the
    // MQTT phase. The MQTT close hangs, so its phase must time out against
    // the REMAINING slice — not the full 200 ms.
    writerMock.close.mockReturnValue(
      new Promise<void>((resolve) => setTimeout(resolve, 100)),
    );

    await networking.close(200);

    const mqttTimeout = logger.write_error.mock.calls.find(
      (call) => call[2]?.event === "mqtt_client_close_timeout",
    );
    expect(mqttTimeout).toBeDefined();
    const budgetMs = mqttTimeout?.[2]?.timeoutMs as number;
    expect(budgetMs).toBeLessThan(200);
    expect(budgetMs).toBeGreaterThan(20);
    // The stuck MQTT close was force-disconnected with a callback.
    expect(mockClient.end).toHaveBeenCalledWith(true, expect.any(Function));
  });
});

describe("MqttNetworking.close() shutdown branches (deterministic)", () => {
  // The real-time tests above cover the wall-clock guarantee (close
  // settles within the budget), but the branch taken at the deadline
  // boundary is a coin flip under real timers: the deadline is computed
  // from Date.now() while setTimeout runs on the event-loop clock, so
  // remainingMs lands on either side of 0 depending on scheduling. Fake
  // timers advance Date.now() and the timers in lockstep, making each
  // branch decision an exact constant so both valid shutdown paths are
  // pinned deterministically.
  const baseConfig: z.infer<typeof configSchema> = {
    logLevel: "info",
    apiPort: 3301,
    mqttBrokerIpAddress: "10.0.0.1",
    mqttTopicTelemetry: "iot/v3/telemetry",
    sensorSourceMaxLength: 30,
    sensorSourceValidCharsRegex: "a-zA-Z0-9._-",
  };

  beforeEach(() => {
    jest.useFakeTimers();
    mockConnect.mockReset();
    (PrometheusWriter as unknown as jest.Mock).mockClear();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  function getMockWriter() {
    return (PrometheusWriter as unknown as jest.Mock).mock.instances.at(
      -1
    ) as unknown as { close: jest.Mock };
  }

  it("forces a best-effort MQTT disconnect without waiting when the drain consumes the whole deadline", async () => {
    const logger = createMockLogger();
    const mockClient = createHangingMqttClient();
    mockConnect.mockReturnValue(mockClient);
    const networking = new MqttNetworking(baseConfig, logger);
    const writerMock = getMockWriter();

    // The drain never finishes, so the shared deadline expires with it
    // still open: remainingMs is exactly 0 at the deadline.
    writerMock.close.mockReturnValue(new Promise<void>(() => {}));

    const closePromise = networking.close(50);
    await jest.advanceTimersByTimeAsync(50);
    await closePromise;

    // The drain timeout was recorded...
    expect(
      logger.write_error.mock.calls.some(
        (call) => call[2]?.event === "prometheus_server_close_timeout"
      )
    ).toBe(true);
    // ...and the MQTT close became a best-effort forced disconnect that
    // does not wait for the client.
    expect(
      logger.write_error.mock.calls.some(
        (call) => call[2]?.event === "mqtt_close_forced_deadline_exhausted"
      )
    ).toBe(true);
    expect(mockClient.end).toHaveBeenCalledTimes(1);
    expect(mockClient.end).toHaveBeenCalledWith(true);
  });

  it("force-disconnects a hanging MQTT close after the remaining budget elapses", async () => {
    const logger = createMockLogger();
    const mockClient = createHangingMqttClient();
    mockConnect.mockReturnValue(mockClient);
    const networking = new MqttNetworking(baseConfig, logger);
    const writerMock = getMockWriter();

    // The drain eats 30 ms of the 100 ms deadline, leaving exactly 70 ms
    // for the MQTT phase. The graceful end(cb) hangs, so the phase must
    // time out against the remaining slice — not the full 100 ms.
    writerMock.close.mockReturnValue(
      new Promise<void>((resolve) => setTimeout(resolve, 30))
    );

    const closePromise = networking.close(100);
    await jest.advanceTimersByTimeAsync(30);
    // The drain finished in time: the graceful disconnect was attempted
    // with the remaining budget, and no false drain-timeout error fired.
    expect(mockClient.end).toHaveBeenCalledWith(expect.any(Function));
    expect(
      logger.write_error.mock.calls.some(
        (call) => call[2]?.event === "prometheus_server_close_timeout"
      )
    ).toBe(false);

    await jest.advanceTimersByTimeAsync(70);
    await closePromise;

    const mqttTimeout = logger.write_error.mock.calls.find(
      (call) => call[2]?.event === "mqtt_client_close_timeout"
    );
    expect(mqttTimeout).toBeDefined();
    expect(mqttTimeout?.[2]?.timeoutMs).toBe(70);
    // The stuck graceful close was rescued by the forced disconnect.
    expect(mockClient.end).toHaveBeenCalledWith(true, expect.any(Function));
  });
});
