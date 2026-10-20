# Screenshots

Real captures of Termavox against test SSH servers: desktop at 1440×900, phone at 390×844 (2x).
They are refreshed when a release changes the UI significantly (`docs/release-checklist.md`).

## Workspace

Named sessions grouped by state on the left, the active one lit in place; a live shell on the
right. Sessions keep running on the server when the browser closes.

![The workspace with four named sessions](workspace.png)

## First use

With no server yet, the workspace explains the three steps and offers one action.

![First use: connect your first server](first-run.png)

## Add server

One page: the server (address, port, user name, and the connection options under Advanced) and
the credential (generate a key, paste one, a password, a saved credential, or none). Nothing is
saved until you submit it.

![Add server](add-server.png)

For a generated key, the result shows the public key with the command that installs it on the
server, and starts a session in one click.

![Server added](add-server-done.png)

## A server's page

Edit the server, test the connection (host key and capability probe) and manage the host keys of
its address. Duplicate copies the server to change its user or key.

![A server's page](server.png)

## On the phone

The session list is its own screen; a session opens full screen with an extra-key bar (Esc, Tab,
Ctrl, Alt, arrows, `|`, paste).

<p>
  <img src="phone-sessions.png" alt="The session list on a phone" width="300">
  <img src="phone-session.png" alt="A session on a phone, with Alt armed" width="300">
</p>
