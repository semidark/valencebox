# ── Stage 1: Build rust-agent natively on 32-bit Alpine ──
FROM i386/alpine:3.22.5 AS agent-builder
RUN apk add --no-cache build-base cargo rust
WORKDIR /app
COPY rust-agent/Cargo.toml rust-agent/Cargo.lock ./
RUN mkdir src && printf 'fn main() {}\n' > src/main.rs
RUN cargo build --release --locked
COPY rust-agent/src ./src
RUN touch src/main.rs && cargo build --release --locked

# ── Stage 2: 32-bit Alpine guest ──
FROM i386/alpine:3.22.5

ENV KERNEL=lts
ENV HOSTNAME=sandbox
ENV PASSWORD=root

# Userland: busybox base + init, getty, bash, real blkid (util-linux)
RUN apk add --no-cache \
  openrc \
  alpine-base \
  agetty \
  bash \
  blkid \
  curl \
  wget \
  ripgrep \
  tmux \
  file

# Runtime deps for the agent binary
RUN apk add --no-cache ca-certificates libgcc

# mkinitfs from Alpine 3.22; nlplug-findfs links libkmod/libblkid/libcryptsetup
# (no OpenSSL issue like 3.19-era edge). Feature flags match v86 IDE disks.
RUN apk add --no-cache mkinitfs

# Kernel without firmware blobs
RUN apk add --no-cache linux-lts linux-firmware-none

# Strip legacy/irrelevant kernel modules: sound, graphics, USB, media,
# wireless, bluetooth, printers/parallel, etc.
# Keep: virtio (console/net), ata/ide/scsi (v86 disks are IDE), ext4, ne2k.
RUN KREL=$(cat /usr/share/kernel/$KERNEL/kernel.release) && \
    cd /lib/modules/$KREL/kernel && \
    rm -rf sound \
           drivers/gpu drivers/media drivers/usb drivers/bluetooth \
           drivers/staging drivers/infiniband drivers/isdn drivers/pcmcia \
           drivers/parport drivers/char/lp* drivers/thunderbolt \
           drivers/net/wireless drivers/net/wwan drivers/net/can \
           drivers/hid drivers/input/joystick drivers/input/touchscreen \
           drivers/input/tablet drivers/iio drivers/leds drivers/mmc \
           drivers/mtd drivers/w1 drivers/watchdog drivers/xen \
           drivers/video net/bluetooth net/wireless net/mac80211 \
           drivers/scsi/aic7xxx drivers/gpio drivers/platform \
           drivers/soc drivers/firmware && \
    depmod $KREL

# Initramfs: ata/ide (v86 IDE disks), ext4 root, virtio
RUN mkinitfs -F "ata base ide scsi virtio ext4" \
    $(cat /usr/share/kernel/$KERNEL/kernel.release)

# Login shell: bash for root, login prompts on VGA tty1 and serial ttyS0
# (both for debugging; the sync agent uses /dev/hvc0, never a getty).
RUN echo "root:$PASSWORD" | chpasswd && \
    sed -i 's|^root:\(.*\):/bin/ash$|root:\1:/bin/bash|' /etc/passwd && \
    sed -i -e 's|^tty1:.*|tty1::respawn:/sbin/agetty tty1 linux|' \
           -e '/^tty[2-6]:/d' /etc/inittab && \
    echo 'ttyS0::respawn:/sbin/agetty -s ttyS0 115200 vt100' >> /etc/inittab && \
    printf 'v86 sandbox (i386) - login: root / root\n' > /etc/motd

# Note: /etc/hostname and /etc/hosts are docker bind mounts during build —
# they are written into the ext4 image by scripts/build-guest.sh instead.

# Ensure virtio drivers load even if hwdrivers misses them
RUN printf 'virtio_console\nvirtio_net\n' >> /etc/modules

# Services: workspace mount + sync agent + eth0 DHCP
COPY rootfs/ /
COPY sync-agent.bin /usr/local/bin/sync-agent
COPY blake2sum.bin /usr/local/bin/blake2sum
COPY --from=agent-builder /app/target/release/agent /usr/local/bin/agent
RUN chmod +x /etc/init.d/workspace /etc/init.d/sync-agent \
    /usr/local/bin/sync-agent /usr/local/bin/blake2sum /usr/local/bin/agent

RUN for i in devfs dmesg mdev hwdrivers; do rc-update add $i sysinit; done && \
    for i in hwclock modules sysctl hostname bootmisc; do rc-update add $i boot; done && \
    for i in workspace sync-agent networking; do rc-update add $i default; done && \
    rc-update add killprocs shutdown
