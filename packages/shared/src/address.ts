/**
 * The one spelling of a server address (plan D-29). Web stores `servers.hostname` through it and
 * the daemon keys `known_host_keys` by it, so `DB.Internal` and `db.internal` are one address.
 * A DNS name and an IP for the same machine stay two addresses, as in OpenSSH's `known_hosts`.
 */
export function normalizeHostname(raw: string): string {
  const trimmed = raw.trim().toLowerCase();
  // `[::1]` and `::1` are the same IPv6 address; store it bare.
  const bracketed = /^\[([^\]]*)\]$/.exec(trimmed);
  return bracketed ? (bracketed[1] ?? '') : trimmed;
}
