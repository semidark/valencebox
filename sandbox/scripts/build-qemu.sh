#!/bin/sh
# Build qemu-system-x86_64 from upstream source for all target platforms.
#
# Uses Docker containers to produce portable (statically linked or
# self-contained) binaries. Each platform gets its own build recipe.
#
# Prerequisites: docker, ~8 GB disk per build, network.
#
# Usage:
#   ./scripts/build-qemu.sh              # build for the current host platform
#   ./scripts/build-qemu.sh linux         # build for a specific platform
#   ./scripts/build-qemu.sh all           # build for all platforms
#
# Output goes to resources/qemu/<platform>/qemu-system-x86_64
# plus any needed firmware blobs.
#
# Builds are cached in build/qemu/ per platform. Re-run to rebuild
# (or delete build/qemu/ to force a clean build).

set -e
cd "$(dirname "$0")/.."

QEMU_VERSION="${QEMU_VERSION:-9.2.4}"
QEMU_TARBALL="qemu-${QEMU_VERSION}.tar.xz"
QEMU_URL="https://download.qemu.org/${QEMU_TARBALL}"
JOBS="${JOBS:-$(nproc 2>/dev/null || echo 4)}"
BUILD_DIR="build/qemu"
RESOURCE_DIR="resources/qemu"

TARGET="${1:-$(uname -s | tr '[:upper:]' '[:lower:]')}"

fetch_qemu() {
    mkdir -p "${BUILD_DIR}"
    if [ ! -f "${BUILD_DIR}/${QEMU_TARBALL}" ]; then
        echo "==> fetching QEMU ${QEMU_VERSION}"
        wget -q -O "${BUILD_DIR}/${QEMU_TARBALL}" "${QEMU_URL}"
    fi
    if [ ! -d "${BUILD_DIR}/qemu-${QEMU_VERSION}" ]; then
        echo "==> extracting"
        tar -xf "${BUILD_DIR}/${QEMU_TARBALL}" -C "${BUILD_DIR}"
    fi
}

install_bin() {
    local platform="$1"
    local src="$2"
    mkdir -p "${RESOURCE_DIR}/${platform}"
    cp "${src}" "${RESOURCE_DIR}/${platform}/qemu-system-x86_64"
    chmod 755 "${RESOURCE_DIR}/${platform}/qemu-system-x86_64"
    echo "=> ${RESOURCE_DIR}/${platform}/qemu-system-x86_64"
}

build_linux() {
    echo "==> building for linux (static, with KVM support)"
    fetch_qemu

    # Build inside a Debian bookworm container with static deps.
    # The heredoc is NOT quoted so shell expands ${QEMU_VERSION} before shipping
    # to docker build. ARG QEMU_VERSION serves as a fallback default inside.
docker build \
        -f - \
        -t "valencebox-qemu-linux:${QEMU_VERSION}" \
        --build-arg "QEMU_VERSION=${QEMU_VERSION}" \
        --build-arg "JOBS=${JOBS}" \
        "${BUILD_DIR}" << DOCKERFILE
FROM alpine:3.20 AS build

ARG QEMU_VERSION
ARG JOBS

RUN apk add --no-cache \
        autoconf \
        automake \
        bash \
        curl \
        dtc \
        file \
        gcc \
        g++ \
        git \
        glib-dev \
        glib-static \
        libtool \
        linux-headers \
        make \
        meson \
        musl-dev \
        ncurses-static \
        ninja \
        pixman-dev \
        pixman-static \
        pkgconfig \
        util-linux-dev \
        util-linux-static \
        zlib-dev \
        zlib-static \
        zstd-static \
        zstd-dev

# Build static libslirp (not in Alpine repos)
WORKDIR /src
RUN curl -sL https://gitlab.freedesktop.org/slirp/libslirp/-/archive/v4.8.0/libslirp-v4.8.0.tar.gz \
    | tar -xz && \
    cd libslirp-v4.8.0 && \
    meson setup build --default-library static --buildtype release -Dprefix=/usr && \
    ninja -C build install

COPY "qemu-\${QEMU_VERSION}.tar.xz" .
RUN tar -xf "qemu-\${QEMU_VERSION}.tar.xz"

WORKDIR /src/build
RUN /src/qemu-\${QEMU_VERSION}/configure \
    --target-list=x86_64-softmmu \
    --enable-kvm \
    --enable-slirp \
    --enable-zstd \
    --disable-bzip2 \
    --disable-docs \
    --disable-gcrypt \
    --disable-gnutls \
    --disable-nettle \
    --disable-werror \
    --static

RUN make -j"\${JOBS}" qemu-system-x86_64

RUN file qemu-system-x86_64 | grep -q -E "statically linked|static-pie" || { echo "NOT STATIC!"; file qemu-system-x86_64; exit 1; }

FROM alpine:3.20
COPY --from=build /src/build/qemu-system-x86_64 /qemu-system-x86_64
COPY --from=build /src/qemu-9.2.4/pc-bios/bios-256k.bin /
COPY --from=build /src/qemu-9.2.4/pc-bios/vgabios-stdvga.bin /
DOCKERFILE

    # Extract the binary + firmware from the image
    local tmpd
    tmpd="$(mktemp -d)"
    docker rm -f valencebox-qemu-extract 2>/dev/null || true
    docker create --name valencebox-qemu-extract "valencebox-qemu-linux:${QEMU_VERSION}" >/dev/null
    docker cp valencebox-qemu-extract:/qemu-system-x86_64 "${tmpd}/qemu-system-x86_64"
    # Also copy firmware blobs
    mkdir -p "${tmpd}/pc-bios"
    docker cp valencebox-qemu-extract:/bios-256k.bin "${tmpd}/pc-bios/" 2>/dev/null || true
    docker cp valencebox-qemu-extract:/vgabios-stdvga.bin "${tmpd}/pc-bios/" 2>/dev/null || true
    docker rm valencebox-qemu-extract >/dev/null

    # Verify it's actually statically linked
    file "${tmpd}/qemu-system-x86_64"
    ldd "${tmpd}/qemu-system-x86_64" 2>&1 | head -5 || true

    install_bin "linux" "${tmpd}/qemu-system-x86_64"
    if [ -d "${tmpd}/pc-bios" ]; then
        cp -r "${tmpd}/pc-bios" "${RESOURCE_DIR}/linux/"
    fi

    rm -rf "${tmpd}"
    echo "==> linux build done"
}

build_darwin() {
    echo "==> building for darwin (macOS, with HVF support)"
    echo "    macOS build not yet implemented — requires macOS CI runner"
    echo "    Manual build on macOS:"
    echo "      brew install ninja pkg-config pixman glib"
    echo "      cd build/qemu/qemu-${QEMU_VERSION}"
    echo "      mkdir build && cd build"
    echo "      ../configure --target-list=x86_64-softmmu --enable-hvf --disable-cocoa"
    echo "      make -j\$(nproc) qemu-system-x86_64"
    mkdir -p "${RESOURCE_DIR}/darwin"
    # Placeholder: create a stub so the app doesn't crash
    echo "Placeholder — build QEMU manually on macOS" > "${RESOURCE_DIR}/darwin/PLATFORM_SETUP_REQUIRED.txt"
    echo "==> darwin build (placeholder)"
}

build_win32() {
    echo "==> building for win32 (Windows, with WHPX support)"
    echo "    Windows build not yet implemented — requires MinGW cross-compiler"
    echo "    Cross-build on Linux with:"
    echo "      apt install mingw-w64"
    echo "      ../configure --target-list=x86_64-softmmu --enable-whpx --cross-prefix=x86_64-w64-mingw32-"
    mkdir -p "${RESOURCE_DIR}/win32"
    echo "Placeholder — build QEMU via MinGW cross-compile" > "${RESOURCE_DIR}/win32/PLATFORM_SETUP_REQUIRED.txt"
    echo "==> win32 build (placeholder)"
}

case "${TARGET}" in
    linux)
        build_linux
        ;;
    darwin|macos)
        build_darwin
        ;;
    win32|windows)
        build_win32
        ;;
    all)
        build_linux
        build_darwin
        build_win32
        ;;
    *)
        echo "unknown target: ${TARGET}"
        echo "usage: $0 [linux|darwin|win32|all]"
        exit 1
        ;;
esac
