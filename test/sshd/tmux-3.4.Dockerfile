# Test-only sshd with the distro tmux of Ubuntu 24.04 (tmux 3.4).
FROM ubuntu:24.04
RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    openssh-server bash coreutils tmux \
  && rm -rf /var/lib/apt/lists/*
COPY sshd_config setup.sh keys/ssh_host_ed25519_key keys/ssh_host_ed25519_key.pub keys/id_ed25519.pub keys/id_ed25519_passphrase.pub /tmp/td-setup/
RUN sh /tmp/td-setup/setup.sh
EXPOSE 22
CMD ["/usr/sbin/sshd", "-D", "-e"]
