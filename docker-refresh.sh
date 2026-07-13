#!/bin/bash

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

echo "Stopping and removing existing services..."
docker compose down 2>/dev/null || true

echo
echo "Building new image..."
docker compose build --no-cache

echo
echo "Starting services..."
docker compose up -d

echo
echo "Waiting for container to start..."
sleep 5

echo
echo "----"
docker image ls -a
echo
docker container ls -a

echo
echo "Container logs:"
docker compose logs -f
