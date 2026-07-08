#!/bin/sh
# Build v86 runtime assets (libv86.js, v86.wasm, seabios.bin, vgabios.bin)
# from the pinned `v86/` git submodule (our fork of copy/v86, carrying a
# patch that bounds AsyncXHRBuffer's disk block_cache — see
# https://github.com/semidark/v86/pull/1, merged into semidark/v86 master).
# Requires Docker.
#
# Output goes to build/v86/ at the repo root; sandbox/scripts/build-guest.sh
# copies from there into sandbox/assets/v86/.
set -e
cd "$(dirname "$0")/.."

if [ ! -f v86/Makefile ]; then
	echo "ERROR: v86/ submodule not initialized" >&2
	echo "  Run first: git submodule update --init v86" >&2
	exit 1
fi

mkdir -p build/v86

echo "==> building v86 (Closure Compiler + Rust/wasm32, via Docker)"
docker build -t tab-microvm-v86 -f scripts/Dockerfile.v86 .
docker rm -f tab-microvm-v86-export >/dev/null 2>&1 || true
docker create --name tab-microvm-v86-export tab-microvm-v86 >/dev/null
docker cp tab-microvm-v86-export:/out/. build/v86/
docker rm tab-microvm-v86-export >/dev/null

ls -lh build/v86/
