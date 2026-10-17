/**
 * How a server's address reads in the UI (plan D-29), like an `ssh` command line: `user@host`,
 * with `:port` only when it is not 22. Browser-safe (the palette and the session list use it).
 * An IPv6 address is stored bare, so it gets brackets whenever a port follows it.
 */

export const DEFAULT_SSH_PORT = 22;

/** `host`, or `host:port` when the port is not 22 (`[::1]:2222` for an IPv6 address). */
export function formatAddress(hostname: string, port: number): string {
  if (port === DEFAULT_SSH_PORT) return hostname;
  return hostname.includes(':') ? `[${hostname}]:${port}` : `${hostname}:${port}`;
}

/**
 * `host:port` with the port always shown: the scope of a host-key decision (plan §5.9), which
 * covers exactly that hostname and port.
 */
export function formatEndpoint(hostname: string, port: number): string {
  return hostname.includes(':') ? `[${hostname}]:${port}` : `${hostname}:${port}`;
}

/** `user@host`, or `user@host:port` when the port is not 22. */
export function formatTarget(username: string, hostname: string, port: number): string {
  return `${username}@${formatAddress(hostname, port)}`;
}
