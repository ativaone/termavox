# Security policy

## Supported versions

Security fixes land on `main` and ship in the next release. Until v1.0, only the latest release
is supported: upgrade to it to get a fix. Release candidates (`-rc` tags) are for testing and
are never supported.

| Version | Supported |
| --- | --- |
| Latest 0.x release | Yes |
| Older releases, release candidates | No |

## Reporting a vulnerability

Report it privately through GitHub:
[**Report a vulnerability**](https://github.com/ativaone/termdock/security/advisories/new)
(the repository's Security tab → Advisories → Report a vulnerability). Only the maintainers see
the report. Please include the version (shown in the account menu), how Termdock is deployed
(Docker Compose, behind your own reverse proxy or not), the steps that show the problem and what
an attacker would gain.

Please do not post vulnerability details in public issues, pull requests or discussions.

What happens next: the maintainers acknowledge the report, work on a fix in a private advisory,
credit you there if you wish, and publish the advisory together with the release that fixes it.
Termdock is maintained by a small team, so give it reasonable time before any disclosure of
your own.

## Security model

How Termdock is meant to be deployed, what it protects against, what it does not, and the
controls it relies on are described in [`docs/security.md`](docs/security.md). Release images
carry build provenance attestations: see the installation guide for how to verify them.
