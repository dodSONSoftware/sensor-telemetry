/*
 * Copyright (c) 2026 dodson Software ( dodson labs )
 * SPDX-License-Identifier: MIT
 */

// Suppress console output during tests
let logSpy: jest.SpyInstance;
let errorSpy: jest.SpyInstance;
let warnSpy: jest.SpyInstance;

// Winston's Console transport bypasses the console methods and writes
// directly to the `console._stdout` / `console._stderr` streams when they
// are set (real streams jest does not expose as `process.stdout` /
// `process.stderr`). They are cleared alongside the console spies so logger
// output stays out of the test output.
let originalStdout: unknown;
let originalStderr: unknown;

beforeEach(() => {
    logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});

    const consoleInternals = console as unknown as Record<string, unknown>;
    originalStdout = consoleInternals["_stdout"];
    originalStderr = consoleInternals["_stderr"];
    consoleInternals["_stdout"] = undefined;
    consoleInternals["_stderr"] = undefined;
});

afterEach(() => {
    logSpy?.mockRestore();
    errorSpy?.mockRestore();
    warnSpy?.mockRestore();

    const consoleInternals = console as unknown as Record<string, unknown>;
    consoleInternals["_stdout"] = originalStdout;
    consoleInternals["_stderr"] = originalStderr;
});
