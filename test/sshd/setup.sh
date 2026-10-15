#!/bin/sh
# Shared build-time provisioning for the test-only sshd images (see keys/README.md).
set -eu
src=/tmp/td-setup
if command -v useradd >/dev/null 2>&1; then
  useradd -m -s /bin/bash td
else
  adduser -D -s /bin/bash td
fi
# Test-only password (password-auth tests). A locked account would also refuse pubkey auth.
echo 'td:termdock-test-password' | chpasswd
mkdir -p /run/sshd
rm -f /etc/ssh/ssh_host_*
install -m 600 "$src/ssh_host_ed25519_key" /etc/ssh/ssh_host_ed25519_key
install -m 644 "$src/ssh_host_ed25519_key.pub" /etc/ssh/ssh_host_ed25519_key.pub
install -m 644 "$src/sshd_config" /etc/ssh/sshd_config
install -d -m 700 -o td -g td /home/td/.ssh
cat "$src/id_ed25519.pub" "$src/id_ed25519_passphrase.pub" > /home/td/.ssh/authorized_keys
chown td:td /home/td/.ssh/authorized_keys
chmod 600 /home/td/.ssh/authorized_keys
rm -rf "$src"
/usr/sbin/sshd -t
