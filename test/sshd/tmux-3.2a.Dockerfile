# Test-only sshd with the distro tmux of Ubuntu 22.04 (tmux 3.2a, the tmux-control floor).
FROM ubuntu:22.04
RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    openssh-server bash coreutils tmux \
  && rm -rf /var/lib/apt/lists/*
COPY sshd_config setup.sh keys/ssh_host_ed25519_key keys/ssh_host_ed25519_key.pub keys/id_ed25519.pub keys/id_ed25519_passphrase.pub /tmp/tv-setup/
RUN sh /tmp/tv-setup/setup.sh
EXPOSE 22
CMD ["/usr/sbin/sshd", "-D", "-e"]
