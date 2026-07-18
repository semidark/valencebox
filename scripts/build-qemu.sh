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
# Output goes to sandbox/resources/qemu/<platform>/qemu-system-x86_64
# plus any needed firmware blobs.
#
# Builds are cached in build/qemu/ at repo root. Re-run to rebuild
# (or delete build/qemu/ to force a clean build).

set -e
cd "$(dirname "$0")/.."

QEMU_VERSION="${QEMU_VERSION:-9.2.4}"
QEMU_TARBALL="qemu-${QEMU_VERSION}.tar.xz"
QEMU_URL="https://download.qemu.org/${QEMU_TARBALL}"
JOBS="${JOBS:-$(nproc 2>/dev/null || echo 4)}"
BUILD_DIR="build/qemu"
RESOURCE_DIR="sandbox/resources/qemu"
TARGET_LIST="${TARGET_LIST:-x86_64-softmmu}"

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
    local name="${3:-$(basename "$src")}"
    mkdir -p "${RESOURCE_DIR}/${platform}"
    cp "${src}" "${RESOURCE_DIR}/${platform}/${name}"
    chmod 755 "${RESOURCE_DIR}/${platform}/${name}"
    echo "=> ${RESOURCE_DIR}/${platform}/${name} ($(du -h "${RESOURCE_DIR}/${platform}/${name}" | cut -f1))"
}

build_linux() {
    echo "==> building for linux (static, with KVM support)"
    fetch_qemu

    # Build inside a Debian bookworm container with static deps.
    # The heredoc is NOT quoted so shell expands ${QEMU_VERSION} (and
    # ${TARGET_LIST}) before shipping to docker build.
docker build \
        -f - \
        -t "valencebox-qemu-linux:${QEMU_VERSION}" \
        --build-arg "QEMU_VERSION=${QEMU_VERSION}" \
        --build-arg "JOBS=${JOBS}" \
        --build-arg "TARGET_LIST=${TARGET_LIST}" \
        "${BUILD_DIR}" << DOCKERFILE
FROM alpine:3.20 AS build

ARG QEMU_VERSION
ARG JOBS
ARG TARGET_LIST

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
    --target-list="\${TARGET_LIST}" \
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

RUN make -j"\${JOBS}"

RUN for f in /src/build/qemu-system-*; do \
        file "\$f" | grep -q -E "statically linked|static-pie" || { echo "NOT STATIC: \$f"; exit 1; }; \
    done

FROM alpine:3.20
COPY --from=build /src/build/qemu-system-* /
COPY --from=build /src/qemu-9.2.4/pc-bios/bios-256k.bin /
COPY --from=build /src/qemu-9.2.4/pc-bios/bios-microvm.bin /
COPY --from=build /src/qemu-9.2.4/pc-bios/vgabios-stdvga.bin /
COPY --from=build /src/qemu-9.2.4/pc-bios/linuxboot_dma.bin /
COPY --from=build /src/qemu-9.2.4/pc-bios/linuxboot.bin /
# Needed for -machine pc (virtio-pci devices)
COPY --from=build /src/qemu-9.2.4/pc-bios/efi-virtio.rom /
COPY --from=build /src/qemu-9.2.4/pc-bios/kvmvapic.bin /
DOCKERFILE

    # Extract the binary + firmware from the image
    local tmpd
    tmpd="$(mktemp -d)"
    docker rm -f valencebox-qemu-extract 2>/dev/null || true
    docker create --name valencebox-qemu-extract "valencebox-qemu-linux:${QEMU_VERSION}" >/dev/null
    for _bin in $(docker export valencebox-qemu-extract | tar -t 2>/dev/null | grep '^qemu-system-' || true); do
        docker cp "valencebox-qemu-extract:/${_bin}" "${tmpd}/${_bin}"
    done
    # Also copy firmware blobs
    mkdir -p "${tmpd}/pc-bios"
    docker cp valencebox-qemu-extract:/bios-256k.bin "${tmpd}/pc-bios/" 2>/dev/null || true
    docker cp valencebox-qemu-extract:/bios-microvm.bin "${tmpd}/pc-bios/" 2>/dev/null || true
    docker cp valencebox-qemu-extract:/vgabios-stdvga.bin "${tmpd}/pc-bios/" 2>/dev/null || true
    docker cp valencebox-qemu-extract:/linuxboot_dma.bin "${tmpd}/pc-bios/" 2>/dev/null || true
    docker cp valencebox-qemu-extract:/linuxboot.bin "${tmpd}/pc-bios/" 2>/dev/null || true
    docker cp valencebox-qemu-extract:/efi-virtio.rom "${tmpd}/pc-bios/" 2>/dev/null || true
    docker cp valencebox-qemu-extract:/kvmvapic.bin "${tmpd}/pc-bios/" 2>/dev/null || true
    docker rm valencebox-qemu-extract >/dev/null

    # Verify all extracted binaries are statically linked
    for _bin in "${tmpd}"/qemu-system-*; do
        [ -f "$_bin" ] || continue
        file "$_bin"
        ldd "$_bin" 2>&1 | head -5 || true
        install_bin "linux" "$_bin"
    done

    if [ -d "${tmpd}/pc-bios" ]; then
        cp -r "${tmpd}/pc-bios" "${RESOURCE_DIR}/linux/"
    fi

    rm -rf "${tmpd}"
    echo "==> linux build done"
}

build_darwin() {
    echo "==> building for darwin (macOS, target list: ${TARGET_LIST})"

    # macOS may lack wget; use curl as fallback
    if ! command -v wget >/dev/null 2>&1; then
        fetch_qemu() {
            mkdir -p "${BUILD_DIR}"
            if [ ! -f "${BUILD_DIR}/${QEMU_TARBALL}" ]; then
                echo "==> fetching QEMU ${QEMU_VERSION} (curl)"
                curl -sL -o "${BUILD_DIR}/${QEMU_TARBALL}" "${QEMU_URL}"
            fi
            if [ ! -d "${BUILD_DIR}/qemu-${QEMU_VERSION}" ]; then
                echo "==> extracting"
                tar -xf "${BUILD_DIR}/${QEMU_TARBALL}" -C "${BUILD_DIR}"
            fi
        }
    fi
    fetch_qemu

    # Prerequisites: brew install on the build machine only (not a runtime dep)
    if ! command -v meson >/dev/null 2>&1; then echo "==> installing meson"; brew install meson; fi
    if ! command -v ninja >/dev/null 2>&1; then echo "==> installing ninja"; brew install ninja; fi
    if ! command -v pkg-config >/dev/null 2>&1; then echo "==> installing pkg-config"; brew install pkg-config; fi
    for pkg in pixman glib; do
        brew list "$pkg" >/dev/null 2>&1 || { echo "==> installing $pkg"; brew install "$pkg"; }
    done

    local jobs
    jobs="$(sysctl -n hw.logicalcpu 2>/dev/null || echo 4)"
    local src_dir="${BUILD_DIR}/qemu-${QEMU_VERSION}"
    local build_dir="${src_dir}/build"
    local out_dir="${RESOURCE_DIR}/darwin"

    rm -rf "${build_dir}"
    mkdir -p "${build_dir}"

    echo "==> configuring QEMU (${TARGET_LIST}, slirp, zstd)"
    (
        cd "${build_dir}"
        ../configure \
            --target-list="${TARGET_LIST}" \
            --enable-slirp \
            --enable-zstd \
            --disable-cocoa \
            --disable-docs \
            --disable-gcrypt \
            --disable-gnutls \
            --disable-nettle \
            --disable-werror
    )

    echo "==> building all system targets (${jobs} jobs)"
    make -C "${build_dir}" -j"${jobs}"

    echo "==> building qemu-img"
    make -C "${build_dir}" -j"${jobs}" qemu-img

    # ── Stage output ──
    mkdir -p "${out_dir}"

    for bin in "${build_dir}"/qemu-system-*; do
        [ -f "$bin" ] || continue
        install_bin darwin "$bin"
    done

    cp "${build_dir}/qemu-img" "${out_dir}/"
    chmod 755 "${out_dir}/qemu-img"
    echo "=> ${out_dir}/qemu-img ($(du -h "${out_dir}/qemu-img" | cut -f1))"

    # Firmware blobs (same set that Linux build extracts)
    mkdir -p "${out_dir}/pc-bios"
    local fw fw_dir="${src_dir}/pc-bios"
    for f in bios-256k.bin bios-microvm.bin vgabios-stdvga.bin \
             linuxboot_dma.bin linuxboot.bin efi-virtio.rom kvmvapic.bin; do
        if [ -f "${fw_dir}/${f}" ]; then
            cp "${fw_dir}/${f}" "${out_dir}/pc-bios/"
        fi
    done
    echo "  firmware: $(ls "${out_dir}/pc-bios/" | wc -l) files in ${out_dir}/pc-bios/"

    # ── Bundle non-system dylibs ──
    local lib_dir="${out_dir}/lib"
    mkdir -p "${lib_dir}"

    # ── Bundle non-system dylibs ──
    echo "  bundling dylibs..."
    local deps_file="/tmp/qemu-darwin-deps-$$.txt"

    for binary in "${out_dir}"/qemu-system-* "${out_dir}/qemu-img"; do
        [ -f "$binary" ] || continue
        otool -L "$binary" 2>/dev/null | tail -n +2 | awk '{print $1}' > "$deps_file"
        while IFS= read -r dylib; do
            case "$dylib" in
                /usr/lib/*|/System/*|@rpath/*|@executable_path/*) continue ;;
            esac
            local name; name="$(basename "$dylib")"
            [ ! -f "${lib_dir}/${name}" ] && cp -n "$dylib" "${lib_dir}/" 2>/dev/null && echo "    dylib: ${name}"
            install_name_tool -change "$dylib" "@executable_path/lib/${name}" "$binary" 2>/dev/null
        done < "$deps_file"
    done

    # Recursively fix dylib cross-dependencies (using temp file to avoid subshell issues)
    local changed=1
    while [ "$changed" -gt 0 ]; do
        changed=0
        for lib in "${lib_dir}"/*.dylib; do
            [ -f "$lib" ] || continue
            local libname; libname="$(basename "$lib")"
            otool -L "$lib" 2>/dev/null | tail -n +2 | awk '{print $1}' > "$deps_file"
            while IFS= read -r dep; do
                case "$dep" in
                    /usr/lib/*|/System/*|@rpath/*|@executable_path/*|@loader_path/*) continue ;;
                esac
                local depname; depname="$(basename "$dep")"
                [ "$depname" = "$libname" ] && continue
                if [ ! -f "${lib_dir}/${depname}" ]; then
                    cp -n "$dep" "${lib_dir}/" 2>/dev/null && echo "    dylib (transitive): ${depname}" && changed=$((changed + 1))
                fi
                install_name_tool -change "$dep" "@loader_path/${depname}" "$lib" 2>/dev/null
            done < "$deps_file"
        done
    done
    rm -f "$deps_file"

    # ── Ad-hoc sign (install_name_tool invalidates code signatures on Apple Silicon) ──
    echo "  signing..."
    for bin in "${out_dir}"/qemu-system-* "${out_dir}/qemu-img"; do
        [ -f "$bin" ] && codesign --force --sign - --timestamp=none "$bin" 2>/dev/null
    done
    for lib in "${lib_dir}"/*.dylib; do
        [ -f "$lib" ] && codesign --force --sign - --timestamp=none "$lib" 2>/dev/null
    done

    # ── Verify no Homebrew references (skip dylib install name / ID line) ──
    local cellar=""
    [ -d "/opt/homebrew" ] && cellar="/opt/homebrew"
    [ -z "$cellar" ] && [ -d "/usr/local/Cellar" ] && cellar="/usr/local/Cellar"
    local leak=0
    if [ -n "$cellar" ]; then
        for _bin in "${out_dir}"/qemu-system-* "${out_dir}/qemu-img"; do
            [ -f "$_bin" ] || continue
            otool -L "$_bin" 2>/dev/null | tail -n +2 | grep -q "$cellar" && leak=1
        done
        for lib in "${lib_dir}"/*.dylib; do
            [ -f "$lib" ] || continue
            otool -L "$lib" 2>/dev/null | tail -n +2 | grep -q "$cellar" && leak=1
        done
    fi
    if [ "$leak" -ne 0 ]; then
        echo "ERROR: Homebrew references remain in staged output (check otool -L for details)"
        exit 1
    fi

    echo "  bundled dylibs: $(ls "${lib_dir}/" 2>/dev/null | wc -l) files in ${lib_dir}/"
    echo "  verified: no Homebrew runtime references"
    echo "==> darwin build done"
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
