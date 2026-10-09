#!/bin/bash

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# ---------------------------------------------------------------------
# Config directory preflight
#
# The container runs as the non-root "node" user (uid 1000, gid 1000 -
# the documented user of the node base image; see the Dockerfile), and
# POST /write-config persists configuration atomically (temp file +
# rename), which only needs write access to the directory. If the host
# config directory does not exist, Docker auto-creates it as root:root
# when the container starts, and a root-owned or non-writable directory
# makes /write-config fail with EACCES. Ensure the directory exists and
# is owned by uid/gid 1000:1000 before starting the service.
# ---------------------------------------------------------------------
CONFIG_DIR="/mnt/sensor-telemetry"
CONFIG_UID=1000
CONFIG_GID=1000

# Run a command directly when root, otherwise escalate with sudo.
run_privileged() {
    if [ "$(id -u)" -eq 0 ]; then
        "$@"
    else
        sudo "$@"
    fi
}

echo "Checking config directory: $CONFIG_DIR (must be owned by ${CONFIG_UID}:${CONFIG_GID})"

if [ ! -d "$CONFIG_DIR" ]; then
    echo "  not found - creating it"
    run_privileged mkdir -p "$CONFIG_DIR"
fi

owner="$(stat -c '%u:%g' "$CONFIG_DIR")"
if [ "$owner" != "${CONFIG_UID}:${CONFIG_GID}" ]; then
    echo "  owned by $owner - chowning to ${CONFIG_UID}:${CONFIG_GID}"
    run_privileged chown "${CONFIG_UID}:${CONFIG_GID}" "$CONFIG_DIR"
fi

mode="$(stat -c '%a' "$CONFIG_DIR")"
if [ $(( 0$mode & 0200 )) -eq 0 ]; then
    echo "  mode $mode has no owner-write bit - adding it"
    run_privileged chmod u+w "$CONFIG_DIR"
fi

if [ ! -f "$CONFIG_DIR/config.yml" ]; then
    echo "  WARNING: $CONFIG_DIR/config.yml is missing - the service will not start until a configuration file is provided"
fi

echo "  config directory ready (owner: $(stat -c '%u:%g' "$CONFIG_DIR"), mode: $(stat -c '%a' "$CONFIG_DIR"))"

echo "Stopping and removing existing services..."
docker compose down 2>/dev/null || true

echo
echo "Building new image..."
docker compose build --no-cache

echo
echo "Starting services (waits for the /health check to pass)..."
# --wait blocks until the service reports healthy per the compose
# healthcheck, and exits non-zero if it never does (default timeout 45s),
# so set -e stops the script instead of continuing against a broken service.
docker compose up --wait

sleep 2

echo
echo "----"
docker image ls -a
echo
docker container ls -a

echo
echo "Container logs:"
docker compose logs -f
