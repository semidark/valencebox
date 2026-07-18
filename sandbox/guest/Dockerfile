# ── Single-stage: Ubuntu guest rootfs (x86-64 or arm64) ──
# Produces a bootable rootfs for QEMU pc/microvm (x86-64) or virt (aarch64)
# with virtio-blk root, workspace qcow2 mount, WebDAV host share, bidir sync.
FROM ubuntu:24.04

# TARGETARCH is auto-populated by docker buildx (amd64 | arm64).
ARG TARGETARCH

ENV HOSTNAME=sandbox

# Prevent dpkg from trying to ask interactive questions when building
ENV DEBIAN_FRONTEND=noninteractive

# Base system: kernel, initramfs, systemd, networking
RUN apt-get update && apt-get install -y --no-install-recommends \
    linux-image-virtual \
    initramfs-tools \
    systemd \
    systemd-sysv \
    dbus \
    openssh-server \
    dhcpcd5 \
    apt-utils \
    curl \
    ripgrep \
    vim-tiny \
    iproute2 \
    ca-certificates && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# davfs2, unison, rsync, inotify-tools for workspace share + sync
RUN apt-get update && apt-get install -y --no-install-recommends \
    davfs2 \
    unison \
    e2fsprogs && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# RTC driver for host-clock time on QEMU -machine virt (aarch64). QEMU's virt
# machine exposes a PL031 RTC seeded with host UTC, but Ubuntu's linux-virt only
# ships rtc-pl031 in linux-modules-extra. Install the extra-modules package whose
# version is derived from the *installed* kernel, so apt version-locks the two:
# a kernel upgrade forces a matching linux-modules-extra (apt refuses a mismatch).
# This is the stable, apt-managed way to get an in-tree module that the base
# linux-virtual metapackage omits — no hand-copied .ko, no version pinning, and
# it survives kernel upgrades. The subsequent strip step trims the bulk we pulled
# in. Without rtc-pl031 there is no /dev/rtc0, so the guest boots at the kernel
# build epoch and the clock is wildly wrong. x86-64 (pc) uses the built-in
# rtc_cmos, so this is only needed for arm64.
RUN if [ "$TARGETARCH" = "arm64" ]; then \
      KREL=$(ls /lib/modules | head -1); \
      apt-get update && \
      apt-get install -y --no-install-recommends "linux-modules-extra-${KREL}" && \
      apt-get clean && rm -rf /var/lib/apt/lists/*; \
    fi

# Explicit initramfs module list. Docker containers have no virtio devices,
# so initramfs-tools auto-detection finds nothing — we must list them here.
# virtio_mmio is needed for -machine microvm (non-PCI transport);
# virtio_blk/ virtio_net are built-in on x86_64 but listed for safety;
# rtc_pl031 provides host-clock time on aarch64 virt (harmless no-op on x86_64,
# where it simply won't load); port/token passed via kernel cmdline.
RUN printf '%s\n' \
    virtio_blk \
    virtio_net \
    virtio_mmio \
    ext4 \
    virtio_console \
    virtio_rng \
    virtio_balloon \
    rtc_pl031 \
    > /etc/initramfs-tools/modules

# MODULES=list keeps only the modules named above in the initramfs. The default
# (MODULES=most) bundles ~2300 modules — harmless on the base linux-virtual set,
# but balloons the initramfs to ~48 MB once linux-modules-extra is installed for
# rtc-pl031. Our device set is fixed (virtio + ext4 + rtc), so `list` is correct
# and shrinks the initramfs back to a few MB.
RUN sed -i 's/^MODULES=.*/MODULES=list/' /etc/initramfs-tools/initramfs.conf

# Rebuild initramfs with the explicit module list baked in
RUN KREL=$(ls /lib/modules | head -1) && \
    mkinitramfs -o /boot/initrd.img-"$KREL" "$KREL"

# Strip irrelevant kernel modules (microvm/pc: no sound, GPU, USB, wireless)
RUN KREL=$(ls /lib/modules | head -1) && \
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
           drivers/gpio drivers/platform drivers/soc \
           drivers/scsi/aic7xxx drivers/scsi/aic79xx drivers/scsi/megaraid \
           drivers/scsi/mpt3sas drivers/scsi/hpsa drivers/scsi/qla2xxx \
           drivers/scsi/lpfc drivers/scsi/be2iscsi drivers/scsi/csiostor \
           drivers/scsi/bfa drivers/scsi/bnx2fc drivers/scsi/qedi \
           drivers/scsi/qedf drivers/scsi/fnic drivers/scsi/isci \
           fs/nfs fs/nfsd fs/cifs fs/ceph fs/smb_client fs/ksmbd \
           fs/btrfs fs/xfs fs/f2fs fs/reiserfs fs/jfs fs/hfs fs/hfsplus \
           fs/ocfs2 fs/ocfs2_dlm fs/isofs fs/udf fs/exfat fs/gfs2 && \
    depmod $KREL

# Create mount points for workspace disk mount and WebDAV mount-share
RUN mkdir -p /workspace /host-workspace

# davfs2 config: no locking, no Expect:100 (SLIRP), short timeouts, cache on root fs
RUN mkdir -p /etc/davfs2 && \
    printf '[DEFAULT]\nuse_locks 0\nuse_expect100 0\nconnect_timeout 10\nread_timeout 30\ngui_optimize 1\ncache_dir /var/cache/davfs2\ncache_size 50\n' > /etc/davfs2/davfs2.conf && \
    chmod 0644 /etc/davfs2/davfs2.conf && chown 0:0 /etc/davfs2 /etc/davfs2/davfs2.conf

# Serial console: systemd serial-getty generator creates
# serial-getty@<device>.service based on console=<device> on the kernel cmdline.
# We create drop-ins for both ttyS0 (x86_64 pc/microvm) and ttyAMA0 (aarch64
# virt) so auto-login works regardless of which console is active. agetty
# positional args are `baud_rate[,...] port [term]` — the baud list comes
# first, then %I (systemd instance name = the tty device).
RUN mkdir -p /etc/systemd/system/serial-getty@ttyS0.service.d && \
    printf '[Service]\nExecStart=\nExecStart=-/sbin/agetty -a root --keep-baud 115200,57600,38400,9600 %%I vt100\nType=idle\n' \
    > /etc/systemd/system/serial-getty@ttyS0.service.d/autologin.conf && \
    mkdir -p /etc/systemd/system/serial-getty@ttyAMA0.service.d && \
    printf '[Service]\nExecStart=\nExecStart=-/sbin/agetty -a root --keep-baud 115200,57600,38400,9600 %%I vt100\nType=idle\n' \
    > /etc/systemd/system/serial-getty@ttyAMA0.service.d/autologin.conf

# Mask unneeded systemd units that could stall in a VM with no hardware.
# systemd-timesyncd is masked: the guest gets correct wall-clock time from the
# QEMU-provided RTC at boot (rtc_cmos on x86-64 pc, rtc-pl031 on aarch64 virt),
# both seeded from the host clock. No NTP/network dependency for time.
RUN systemctl mask \
    bluetooth.service \
    wpa_supplicant.service \
    systemd-timesyncd.service \
    systemd-resolved.service \
    systemd-networkd-wait-online.service \
    fstrim.timer

# /etc/hosts and hostname are set in build-guest.sh after docker export
# (Docker overlayfs prevents in-place editing of /etc/hosts in the base image).
RUN echo sandbox > /etc/hostname

# motd
RUN printf '\nsandbox login ready (Ubuntu 24.04)\n' > /etc/motd

# NOTE: No /workspace entry in /etc/fstab. mount-share.service manages the
# workspace disk lifecycle — it formats the raw qcow2 on first boot (blkid
# guard), then mounts it explicitly. If fstab mounted workspace.mount, systemd
# would fail permanently on first boot when the disk has no filesystem.

# SSH: lightweight host key (ed25519-only), fast ciphers, root key auth
# authorized_keys is injected at build time (build-guest.sh) so the same
# keypair works for host SSH access without manual setup.
RUN rm -f /etc/ssh/ssh_host_ed25519_key /etc/ssh/ssh_host_ed25519_key.pub && \
    ssh-keygen -t ed25519 -f /etc/ssh/ssh_host_ed25519_key -N '' && \
    printf 'HostKey /etc/ssh/ssh_host_ed25519_key\nPasswordAuthentication no\nPermitRootLogin prohibit-password\nClientAliveInterval 30\nCiphers chacha20-poly1305@openssh.com\nKexAlgorithms curve25519-sha256\nMACs umac-64-etm@openssh.com\n' > /etc/ssh/sshd_config

# DHCP on eth0 via dhcpcd (systemd-networkd is masked)
RUN systemctl enable dhcpcd

# Enable SSH
RUN systemctl enable ssh

# Copy systemd unit files for mount-share and workspace-sync
COPY etc/systemd/system/mount-share.service /etc/systemd/system/mount-share.service
COPY etc/systemd/system/workspace-sync.service /etc/systemd/system/workspace-sync.service
RUN systemctl enable mount-share && systemctl enable workspace-sync

# Copy helper scripts
COPY usr/local/libexec/mount-share.sh /usr/local/libexec/mount-share.sh
COPY usr/local/libexec/workspace-sync.sh /usr/local/libexec/workspace-sync.sh
RUN chmod +x /usr/local/libexec/mount-share.sh /usr/local/libexec/workspace-sync.sh

# Strip bloat
RUN rm -rf /usr/share/man /usr/share/doc /usr/share/info /usr/share/i18n \
    /usr/share/zoneinfo/iso3166.rst /usr/share/licenses \
    /var/cache/* /tmp/* /root/.cache /var/lib/apt/lists/*
