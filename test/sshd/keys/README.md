# TEST-ONLY KEYS — never use them anywhere else

Every file in this directory is **public, committed test material** for the `test/sshd` containers.
None of it protects anything; do not reuse it on a real host, account or service.

| File | Purpose |
|---|---|
| `ssh_host_ed25519_key`, `.pub` | Fixed sshd host key baked into every test image, so clients pre-trust it. |
| `id_ed25519`, `.pub` | User key for `tv` (no passphrase), installed in `authorized_keys`. |
| `id_ed25519_passphrase`, `.pub` | User key for `tv` protected by the passphrase `termavox-test-passphrase`. |

The test user `tv` also has the password `termavox-test-password` (password-auth tests).

Host-key verification is never disabled: tests and `test/sshd/smoke.ts` derive the expected
fingerprint from `ssh_host_ed25519_key.pub` and reject anything else.

```text
SHA256:6AKabYDKazOSI5KmhV+r75VtW0R9OgAQruCvlIUzYvI  ssh_host_ed25519_key.pub (ED25519)
SHA256:l0QRLCAtKH6Gb16KKefB+gzm47fuHwPGrLltuW+6G94  id_ed25519.pub (ED25519)
SHA256:1PlqH0an5DRVicYlY7yYpNe3Sn4L80cKPFetGTHbww8  id_ed25519_passphrase.pub (ED25519)
```

For a manual OpenSSH session, copy the key somewhere private first (git does not keep mode 0600)
and pin the host key with the committed `known_hosts`:

```sh
install -m 600 test/sshd/keys/id_ed25519 /tmp/tv_id_ed25519
ssh -i /tmp/tv_id_ed25519 -o UserKnownHostsFile=test/sshd/keys/known_hosts -p 2202 tv@127.0.0.1
```
