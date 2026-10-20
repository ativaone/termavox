#!/bin/sh
# Shared build-time provisioning for the test-only sshd images (see keys/README.md).
set -eu
src=/tmp/tv-setup
if command -v useradd >/dev/null 2>&1; then
  useradd -m -s /bin/bash tv
else
  adduser -D -s /bin/bash tv
fi
# Test-only password (password-auth tests). A locked account would also refuse pubkey auth.
echo 'tv:termavox-test-password' | chpasswd
mkdir -p /run/sshd
rm -f /etc/ssh/ssh_host_*
install -m 600 "$src/ssh_host_ed25519_key" /etc/ssh/ssh_host_ed25519_key
install -m 644 "$src/ssh_host_ed25519_key.pub" /etc/ssh/ssh_host_ed25519_key.pub
install -m 644 "$src/sshd_config" /etc/ssh/sshd_config
install -d -m 700 -o tv -g tv /home/tv/.ssh
cat "$src/id_ed25519.pub" "$src/id_ed25519_passphrase.pub" > /home/tv/.ssh/authorized_keys
chown tv:tv /home/tv/.ssh/authorized_keys
chmod 600 /home/tv/.ssh/authorized_keys
rm -rf "$src"
/usr/sbin/sshd -t
