/**
 * The one-line POSIX sh command that appends an OpenSSH public key to the current user's
 * `~/.ssh/authorized_keys`, creating the directory and fixing modes. The key is single-quoted, so
 * nothing in it is expanded by the shell.
 */
export function installCommand(publicKey: string): string {
  const quoted = `'${publicKey.replaceAll("'", `'\\''`)}'`;
  return `mkdir -p ~/.ssh && chmod 700 ~/.ssh && printf '%s\\n' ${quoted} >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys`;
}
