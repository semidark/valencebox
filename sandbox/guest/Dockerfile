# Minimal 32-bit Alpine guest for the v86 sandbox (v86 emulates 32-bit x86
# only). Root fs becomes an ext4 disk image (hda); /workspace is a second
# ext4 disk (hdb). Alpine 3.18.6 pinned: mkinitfs in 3.19+ breaks 9p/edge
# cases; kernel is Alpine linux-lts with legacy module trees stripped.
FROM i386/alpine:3.18.6

ENV KERNEL=lts
ENV HOSTNAME=sandbox
ENV PASSWORD=root

# Userland: busybox base + init, getty, bash, real blkid (util-linux)
RUN apk add --no-cache openrc alpine-base agetty bash blkid

# stock 3.18 mkinitfs (edge mkinitfs links a newer OpenSSL and its
# nlplug-findfs crashes at boot; the edge version was only needed for 9p root)
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
           drivers/scsi/aic7xxx drivers/gpio drivers/platform && \
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
RUN chmod +x /etc/init.d/workspace /etc/init.d/sync-agent \
    /usr/local/bin/sync-agent /usr/local/bin/blake2sum

RUN for i in devfs dmesg mdev hwdrivers; do rc-update add $i sysinit; done && \
    for i in hwclock modules sysctl hostname bootmisc; do rc-update add $i boot; done && \
    for i in workspace sync-agent networking; do rc-update add $i default; done && \
    rc-update add killprocs shutdown
