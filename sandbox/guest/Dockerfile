# ── Single-stage: x86-64 Alpine guest rootfs ──
# Produces a bootable rootfs for QEMU microvm with virtio-blk root,
# workspace qcow2 mount, WebDAV host share, and bidir sync service.
FROM amd64/alpine:3.21

ENV KERNEL=virt
ENV HOSTNAME=sandbox

# Userland: busybox init, serial getty, networking, sync
RUN apk add --no-cache \
    alpine-base \
    linux-virt \
    mkinitfs \
    agetty \
    openssh \
    dhcpcd \
    curl \
    davfs2 \
    unison \
    rsync \
    inotify-tools \
    e2fsprogs

# Rebuild initramfs with ext4 + virtio features (default virt initramfs only
# has "base", which doesn't include ext4.ko). The linux-virt trigger already
# built /boot/initramfs-virt once; we overwrite it with the right features.
RUN mkinitfs -F "base ext4 virtio" \
    $(cat /usr/share/kernel/$KERNEL/kernel.release)

# Strip irrelevant kernel modules (microvm: no sound, GPU, USB, wireless, etc.)
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
           drivers/gpio drivers/platform drivers/soc \
           drivers/scsi/aic7xxx drivers/scsi/aic79xx drivers/scsi/megaraid \
           drivers/scsi/mpt3sas drivers/scsi/hpsa drivers/scsi/qla2xxx \
           drivers/scsi/lpfc drivers/scsi/be2iscsi drivers/scsi/csiostor \
           drivers/scsi/bfa drivers/scsi/bnx2fc drivers/scsi/qedi \
           drivers/scsi/qedf drivers/scsi/fnic drivers/scsi/isci \
           fs/nfs fs/nfsd fs/cifs fs/ceph fs/smb_client fs/ksmbd \
           fs/btrfs fs/xfs fs/f2fs fs/reiserfs fs/jfs fs/hfs fs/hfsplus \
           fs/ocfs2 fs/ocfs2_dlm fs/isofs fs/udf fs/exfat && \
    depmod $KREL

# davfs2 config: no locking, no Expect:100 (SLIRP), short timeouts, cache on workspace volume
RUN mkdir -p /etc/davfs2 && \
    printf '[DEFAULT]\nuse_locks 0\nuse_expect100 0\nconnect_timeout 10\nread_timeout 30\ncache_dir /workspace/.davfs2-cache\ncache_size 50\n' > /etc/davfs2/davfs2.conf && \
    chmod 0644 /etc/davfs2/davfs2.conf && chown 0:0 /etc/davfs2 /etc/davfs2/davfs2.conf

# Ensure virtio modules load at boot
RUN printf 'virtio_blk\nvirtio_net\nqemu_fw_cfg\nfuse\n' >> /etc/modules

# Serial console: root auto-login on ttyS0 at 115200
RUN echo 'ttyS0::respawn:/sbin/agetty -a root -s ttyS0 115200 vt100' >> /etc/inittab && \
    printf '\nsandbox login ready (x86-64, linux-virt)\n' > /etc/motd

# DHCP on SLIRP eth0
RUN printf 'auto lo\niface lo inet loopback\n\nauto eth0\niface eth0 inet dhcp\n' \
    > /etc/network/interfaces

# Strip bloat
RUN rm -rf /usr/share/man /usr/share/doc /usr/share/info /usr/share/i18n \
    /usr/share/zoneinfo/iso3166.rst /usr/share/licenses \
    /var/cache/* /tmp/* /root/.cache

# Copy init scripts for workspace mount and sync
COPY etc/init.d/mount-share /etc/init.d/mount-share
COPY etc/init.d/workspace-sync /etc/init.d/workspace-sync
RUN chmod +x /etc/init.d/mount-share /etc/init.d/workspace-sync

# Minimal OpenRC runlevel
RUN for i in devfs dmesg mdev; do rc-update add $i sysinit; done && \
    for i in hwclock modules sysctl hostname bootmisc; do rc-update add $i boot; done && \
    rc-update add networking default && \
    rc-update add mount-share default && \
    rc-update add workspace-sync default && \
    rc-update add killprocs shutdown
