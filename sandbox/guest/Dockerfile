# ── Stage 1: Build rust-agent natively on 32-bit Alpine ──
FROM i386/alpine:3.22.5 AS agent-builder
RUN apk add --no-cache build-base cargo rust
WORKDIR /app
COPY rust-agent/Cargo.toml rust-agent/Cargo.lock ./
RUN mkdir src && printf 'fn main() {}\n' > src/main.rs
RUN cargo build --release --locked
COPY rust-agent/src ./src
RUN touch src/main.rs && cargo build --release --locked

# ── Stage 2: Build kernel + initramfs in an isolated stage ──
# linux-lts + mkinitfs (and their transitive deps: cryptsetup-libs,
# lvm2-libs, libblkid, libkmod, e2fsprogs-libs) are NOT needed on the
# final root disk — the initramfs they produce is exported to v86 as a
# separate boot asset (build-guest.sh extracts /boot/initramfs-lts).
# Keeping them out of stage 3 is the single biggest bloat saving here.
FROM i386/alpine:3.22.5 AS kernel-builder
ENV KERNEL=lts
RUN apk add --no-cache mkinitfs linux-lts linux-firmware-none

# Strip legacy/irrelevant kernel modules (micro-VM style): sound, graphics,
# USB, media, wireless, bluetooth, printers/parallel, exotic HBA drivers,
# network filesystems/non-ext4 filesystems, etc.
# KEEP (v86 needs these): virtio (console/net), the libata/ata_piix IDE
# controller path, and the SCSI midlayer (sd_mod + scsi_mod) — v86 disks
# enumerate as IDE but mount /dev/sdX through the SCSI block layer, and
# the kernel cmdline at vm.ts uses modules=ata_piix,sd-mod,ext4.
RUN KREL=$(cat /usr/share/kernel/$KERNEL/kernel.release) && \
    cd /lib/modules/$KREL/kernel && \
    rm -rf sound \
           drivers/gpu drivers/media drivers/usb drivers/bluetooth \
           drivers/staging drivers/infiniband drivers/isdn drivers/pcmcia \
           drivers/parport drivers/char/lp* drivers/thunderbolt \
           drivers/net/wireless drivers/net/wwan drivers/net/can \
           drivers/net/dsa \
           drivers/hid drivers/input/joystick drivers/input/touchscreen \
           drivers/input/tablet drivers/iio drivers/leds drivers/mmc \
           drivers/mtd drivers/w1 drivers/watchdog drivers/xen \
           drivers/video net/bluetooth net/wireless net/mac80211 \
           net/nfc net/6lowpan net/ieee802154 net/qrtr net/rfkill \
           drivers/char/agp drivers/char/ipmi drivers/char/hw_random \
           drivers/char/tpm drivers/char/mwave drivers/char/drm \
           drivers/gpio drivers/platform drivers/soc drivers/firmware \
           drivers/scsi/aic7xxx drivers/scsi/aic79xx drivers/scsi/megaraid \
           drivers/scsi/mpt3sas drivers/scsi/hpsa drivers/scsi/qla2xxx \
           drivers/scsi/lpfc drivers/scsi/be2iscsi drivers/scsi/csiostor \
           drivers/scsi/bfa drivers/scsi/bnx2fc drivers/scsi/qedi \
           drivers/scsi/qedf drivers/scsi/fnic drivers/scsi/isci \
           fs/nfs fs/nfsd fs/cifs fs/ceph fs/smb_client fs/ksmbd \
           fs/btrfs fs/xfs fs/f2fs fs/reiserfs fs/jfs fs/hfs fs/hfsplus \
           fs/ocfs2 fs/ocfs2_dlm fs/isofs fs/udf fs/exfat && \
    depmod $KREL

# Initramfs: ata/ide (v86 IDE disks), scsi (sd_mod block layer), ext4 root,
# virtio. Features mirror the kernel cmdline in src/main/vm.ts.
RUN mkinitfs -F "ata base ide scsi virtio ext4" \
    $(cat /usr/share/kernel/$KERNEL/kernel.release)

# ── Stage 3: 32-bit Alpine guest rootfs (no kernel/mkinitfs) ──
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

# Kernel modules + prebuilt initramfs come from the kernel-builder stage;
# stage 3 deliberately does NOT install linux-lts / mkinitfs (see top of
# kernel-builder for why). build-guest.sh extracts /boot/initramfs-lts
# to images/initramfs.bin and /boot/vmlinuz-lts to images/vmlinuz.bin at
# image-export time.
COPY --from=kernel-builder /lib/modules /lib/modules
COPY --from=kernel-builder /boot/initramfs-lts /boot/initramfs-lts
COPY --from=kernel-builder /boot/vmlinuz-lts /boot/vmlinuz-lts

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

# Strip bloat that apk leaves behind (man pages, docs, locales, zoneinfo
# stubs, licenses). Single RUN keeps the layer count down.
RUN rm -rf /usr/share/man /usr/share/doc /usr/share/info /usr/share/i18n \
    /usr/share/zoneinfo/iso3166.rst /usr/share/licenses \
    /var/cache/* /tmp/* /root/.cache

# OpenRC runlevels. Skipping `hwdrivers` in sysinit (the service that
# prints "Loading hardware drivers" and walks every /sys modalias running
# modprobe twice) is a major boot-speed win; our only drivers are
# already loaded by the kernel cmdline (modules=ata_piix,sd-mod,ext4) and
# /etc/modules (virtio_console, virtio_net). devfs + mdev stay (mdev
# provides the `dev` service other things depend on; devtmpfs already
# has /dev/sda|sdb|hvc0 nodes, so mdev -s coldplug is fast on v86).
RUN for i in devfs dmesg mdev; do rc-update add $i sysinit; done && \
    for i in hwclock modules sysctl hostname bootmisc; do rc-update add $i boot; done && \
    for i in workspace sync-agent networking; do rc-update add $i default; done && \
    rc-update add killprocs shutdown
