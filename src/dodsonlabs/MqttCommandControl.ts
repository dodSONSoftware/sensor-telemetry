/*
 * Copyright (c) 2026 dodson Software ( dodson labs )
 * SPDX-License-Identifier: MIT
 */

import type { IMqttCommandControl, MqttCommandResult } from "./Interfaces";

const __default_timeout_duration_ms = 1500;

export class MqttCommandControl implements IMqttCommandControl {
    is_running: boolean = false;
    is_timed_out: boolean = false;
    timeout: NodeJS.Timeout | null = null;
    results: MqttCommandResult[] = [];
    timeout_duration_ms = __default_timeout_duration_ms;

    // Event-based completion signaling (replaces polling)
    private completion_resolver: (() => void) | null = null;
    private completion_promise: Promise<void> | null = null;

    constructor(timeout_dur_ms: number = __default_timeout_duration_ms) {
        this.timeout_duration_ms = timeout_dur_ms;
    }

    public initialize() {
        this.is_running = true;
        this.is_timed_out = false;
        this.results = [];
        this.restart_clock();
    }

    public deinitialize() {
        this.is_running = false;
        this.is_timed_out = true;
        this.cancel_clock();
        this.resolve_completion();
    }

    public clear_results() {
        this.results = [];
    }

    public restart_clock() {
        // A new response arrived — clear the existing timeout and start a fresh
        // silence timer.  Do NOT resolve the completion promise here; the promise
        // should only resolve when the silence timeout fires (no more responses)
        // or when deinitialize() is called.
        if (this.timeout) {
            clearTimeout(this.timeout);
        }
        this.timeout = setTimeout(() => {
            this.is_timed_out = true;
            this.resolve_completion();
        }, this.timeout_duration_ms);
    }

    public cancel_clock() {
        if (this.timeout) {
            clearTimeout(this.timeout);
            this.timeout = null;
        }
    }

    /**
     * Wait for the command to complete (timeout or deinitialize).
     * Returns immediately if already timed out.
     * Resolves when no more responses arrive within the timeout window.
     */
    public waitForCompletion(): Promise<void> {
        if (this.is_timed_out) {
            return Promise.resolve();
        }
        if (this.completion_promise) {
            return this.completion_promise;
        }
        this.completion_promise = new Promise<void>((resolve) => {
            this.completion_resolver = resolve;
        });
        return this.completion_promise;
    }

    private resolve_completion() {
        if (this.completion_resolver) {
            this.completion_resolver();
            this.completion_resolver = null;
            this.completion_promise = null;
        }
    }
}
