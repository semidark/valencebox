# Minimal 32-bit guest for env86/v86 (v86 emulates a 32-bit x86 CPU only,
# so a 64-bit-only distro like Fedora CoreOS cannot boot here).
# Alpine 3.18.6 pinned: mkinitfs in 3.19+ has known issues with 9p root.
FROM i386/alpine:3.18.6

ENV KERNEL=lts
ENV HOSTNAME=microvm
ENV PASSWORD=root

# Minimal userland: busybox is in the base image; add init, getty, bash.
RUN apk add --no-cache openrc alpine-base agetty alpine-conf bash

# mkinitfs from edge (3.18's mkinitfs doesn't handle 9p root properly)
RUN apk add --no-cache mkinitfs --allow-untrusted \
    --repository https://dl-cdn.alpinelinux.org/alpine/edge/main/

# Kernel without firmware blobs
RUN apk add --no-cache linux-lts linux-firmware-none

# Strip legacy/irrelevant kernel modules: sound, graphics, USB, media,
# wireless, bluetooth, printers/parallel port, infiniband, etc.
# Keep: virtio, 9p, ext4, ata/ide/scsi (initramfs features), ne2k net.
RUN KREL=$(cat /usr/share/kernel/$KERNEL/kernel.release) && \
    cd /lib/modules/$KREL/kernel && \
    rm -rf sound \
           drivers/gpu drivers/media drivers/usb drivers/bluetooth \
           drivers/staging drivers/infiniband drivers/isdn drivers/pcmcia \
           drivers/parport drivers/char/lp* drivers/usb drivers/thunderbolt \
           drivers/net/wireless drivers/net/wwan drivers/net/can \
           drivers/hid drivers/input/joystick drivers/input/touchscreen \
           drivers/input/tablet drivers/iio drivers/leds drivers/mmc \
           drivers/mtd drivers/w1 drivers/watchdog drivers/xen \
           drivers/video net/bluetooth net/wireless net/mac80211 \
           drivers/scsi/aic7xxx drivers/gpio drivers/platform && \
    depmod $KREL

# Initramfs with 9p so the kernel can mount the host filesystem as root
RUN mkinitfs -F "ata base ide scsi virtio ext4 9p" \
    $(cat /usr/share/kernel/$KERNEL/kernel.release)

# Login shell: bash for root, real login prompt on VGA text console (the
# browser tab) and serial ttyS0. No gettys on tty2-6.
RUN echo "root:$PASSWORD" | chpasswd && \
    sed -i 's|^root:\(.*\):/bin/ash$|root:\1:/bin/bash|' /etc/passwd && \
    sed -i -e 's|^tty1:.*|tty1::respawn:/sbin/agetty tty1 linux|' \
           -e '/^tty[2-6]:/d' /etc/inittab && \
    echo 'ttyS0::respawn:/sbin/agetty -s ttyS0 115200 vt100' >> /etc/inittab && \
    printf 'microvm (env86/v86, i386) - login: root / root\n' > /etc/motd

# Guest networking helper for `env86 boot --net` (run manually when needed)
# /etc/hosts and /etc/hostname can't be written at build time (docker
# bind-mounts them), so they are (re)written on every boot via inittab
# sysinit, before openrc's hostname service runs.
RUN printf 'rmmod ne2k-pci 2>/dev/null; modprobe ne2k-pci\nhwclock -s\nsetup-interfaces -a -r\n' \
    > /root/networking.sh && chmod +x /root/networking.sh && \
    printf "#!/bin/sh\necho $HOSTNAME > /etc/hostname\necho '127.0.0.1 localhost %s' > /etc/hosts\n" "$HOSTNAME" \
    > /sbin/firstboot.sh && chmod +x /sbin/firstboot.sh && \
    sed -i '1i ::sysinit:/sbin/firstboot.sh' /etc/inittab

# Minimal OpenRC service set
RUN for i in devfs dmesg mdev hwdrivers; do rc-update add $i sysinit; done && \
    for i in modules sysctl hostname bootmisc; do rc-update add $i boot; done && \
    rc-update add killprocs shutdown
