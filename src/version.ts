/*
 * Copyright (c) 2026 dodson Software ( dodson labs )
 * SPDX-License-Identifier: MIT
 */

// **** Application version information
// APP_VERSION is the source of truth for the app version (reported by /about).
// package.json must be kept in sync with it.
// NOTE: No trailing semicolon on these lines — the /git-commit workflow's
// replace-and-verify scripts match exactly: export const APP_VERSION = "<version>"
export const APP_VERSION = "4.1.34"
// **** Release codename
// Deterministic function of APP_VERSION per the release codename scheme:
// MAJOR → Animal, MINOR → Material, displayed as "<Material> <Animal>".
// NOTE: No trailing semicolon (see above).
export const APP_NAME = "Zinc Falcon"
