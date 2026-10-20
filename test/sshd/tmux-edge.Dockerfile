# Test-only sshd with the newest packaged tmux (Alpine edge).
FROM alpine:edge
RUN apk add --no-cache openssh-server bash coreutils tmux musl-locales ncurses
COPY sshd_config setup.sh keys/ssh_host_ed25519_key keys/ssh_host_ed25519_key.pub keys/id_ed25519.pub keys/id_ed25519_passphrase.pub /tmp/tv-setup/
RUN sh /tmp/tv-setup/setup.sh
EXPOSE 22
CMD ["/usr/sbin/sshd", "-D", "-e"]
