/**
 * A new server's session options (plan D-29) and whether a set of form values departs from them.
 * Browser-safe: the Add form opens its "Advanced" disclosure when a duplicated server (or an
 * echoed submit) carries options other than these, so an inherited startup command or
 * environment is never hidden.
 */

export interface ServerOptionsValues {
  protectionMode: 'auto' | 'off';
  startupCommand: string;
  env: Array<{ key: string; value: string }>;
  keepaliveIntervalS: number;
  autoReopen: boolean;
  scrollbackLines: number;
}

export const SERVER_OPTION_DEFAULTS: ServerOptionsValues = {
  protectionMode: 'auto',
  startupCommand: '',
  env: [],
  keepaliveIntervalS: 15,
  autoReopen: true,
  scrollbackLines: 5000,
};

function envRows(json: string | undefined): number {
  if (!json) return 0;
  try {
    const rows = JSON.parse(json) as unknown;
    return Array.isArray(rows) ? rows.length : 0;
  } catch {
    return 0;
  }
}

/**
 * Whether the option inputs in `values` (names with `prefix`, as the forms post and echo them)
 * differ from the defaults. A missing input counts as its default.
 */
export function optionsDifferFromDefaults(
  values: Record<string, string>,
  prefix = '',
  defaults: ServerOptionsValues = SERVER_OPTION_DEFAULTS,
): boolean {
  const v = (name: string) => values[`${prefix}${name}`];
  const differs = (name: string, fallback: string) => {
    const value = v(name);
    return value !== undefined && value.trim() !== fallback;
  };
  return (
    differs('protectionMode', defaults.protectionMode) ||
    differs('startupCommand', defaults.startupCommand) ||
    differs('keepaliveIntervalS', String(defaults.keepaliveIntervalS)) ||
    differs('scrollbackLines', String(defaults.scrollbackLines)) ||
    differs('autoReopen', defaults.autoReopen ? 'on' : '') ||
    envRows(v('env')) > 0
  );
}
