import type { ReactNode, SVGProps } from 'react';

/**
 * Termdock's icon set: authored inline SVG on a 24-unit grid, 1.75 stroke, round caps and
 * joins, drawn in currentColor. Icons are decorative (aria-hidden); the control that holds one
 * carries the accessible name.
 */
export type IconProps = Omit<SVGProps<SVGSVGElement>, 'children'> & { size?: number };

function Icon({ size = 16, children, ...props }: IconProps & { children: ReactNode }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      {children}
    </svg>
  );
}

const SHIELD = 'M12 3.25 19 6v5.25c0 4.4-2.9 8.1-7 9.5-4.1-1.4-7-5.1-7-9.5V6l7-2.75Z';

/** Protected session (tmux control mode). */
export function ShieldIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d={SHIELD} fill="currentColor" />
    </Icon>
  );
}

/** Protected in compatibility mode (tmux normal mode). */
export function ShieldOutlineIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d={SHIELD} />
    </Icon>
  );
}

/** Not protected. */
export function ShieldOffIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d={SHIELD} strokeDasharray="2.5 2.5" />
      <path d="M4 4l16 16" />
    </Icon>
  );
}

/** Protection not decided yet (session still starting). */
export function ShieldPendingIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d={SHIELD} strokeDasharray="2.5 2.5" />
    </Icon>
  );
}

export function PlusIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 5v14M5 12h14" />
    </Icon>
  );
}

export function ChevronDownIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="m6 9 6 6 6-6" />
    </Icon>
  );
}

export function ChevronRightIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="m9 6 6 6-6 6" />
    </Icon>
  );
}

export function ChevronLeftIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="m15 6-6 6 6 6" />
    </Icon>
  );
}

export function ArrowUpIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 19V5M6 11l6-6 6 6" />
    </Icon>
  );
}

export function ArrowDownIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 5v14M6 13l6 6 6-6" />
    </Icon>
  );
}

export function ArrowLeftIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M19 12H5M11 6l-6 6 6 6" />
    </Icon>
  );
}

export function ArrowRightIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M5 12h14M13 6l6 6-6 6" />
    </Icon>
  );
}

export function EyeIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" />
      <circle cx="12" cy="12" r="2.75" />
    </Icon>
  );
}

export function EyeOffIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M9.9 5.75A9.6 9.6 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a16 16 0 0 1-2.6 3.4M6.3 7.3A16 16 0 0 0 2.5 12S6 18.5 12 18.5a9.3 9.3 0 0 0 4.4-1.1" />
      <path d="M10.1 10.1a2.75 2.75 0 0 0 3.8 3.8" />
      <path d="M3.5 3.5l17 17" />
    </Icon>
  );
}

export function CopyIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="8.5" y="8.5" width="11.5" height="11.5" rx="1.75" />
      <path d="M15.5 8.5V5.75A1.75 1.75 0 0 0 13.75 4h-8A1.75 1.75 0 0 0 4 5.75v8c0 .97.78 1.75 1.75 1.75H8.5" />
    </Icon>
  );
}

export function CheckIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="m5 12.5 4.5 4.5L19 7.5" />
    </Icon>
  );
}

export function AlertIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M10.3 4.2 2.9 17.5A2 2 0 0 0 4.6 20.5h14.8a2 2 0 0 0 1.7-3L13.7 4.2a2 2 0 0 0-3.4 0Z" />
      <path d="M12 9.5v4.25M12 17h.01" />
    </Icon>
  );
}

export function InfoIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="8.75" />
      <path d="M12 11v5.5M12 7.75h.01" />
    </Icon>
  );
}

export function CloseIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />
    </Icon>
  );
}

export function SignOutIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M14.5 4.5h3.25A1.75 1.75 0 0 1 19.5 6.25v11.5a1.75 1.75 0 0 1-1.75 1.75H14.5" />
      <path d="m9.5 16.5-4.5-4.5 4.5-4.5M5 12h10" />
    </Icon>
  );
}

export function ServerIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="3.5" y="4" width="17" height="7" rx="1.5" />
      <rect x="3.5" y="13" width="17" height="7" rx="1.5" />
      <path d="M7.5 7.5h.01M7.5 16.5h.01M11 7.5h5.5M11 16.5h5.5" />
    </Icon>
  );
}

export function KeyIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="8" cy="15.5" r="3.75" />
      <path d="M10.75 12.75 19.5 4M16.5 7l2.5 2.5M14 9.5l2 2" />
    </Icon>
  );
}

export function PlayIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M7.5 5.5v13l10.5-6.5-10.5-6.5Z" />
    </Icon>
  );
}

export function PasteIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M15.5 5h1.75A1.75 1.75 0 0 1 19 6.75v12.5A1.75 1.75 0 0 1 17.25 21H6.75A1.75 1.75 0 0 1 5 19.25V6.75A1.75 1.75 0 0 1 6.75 5H8.5" />
      <rect x="8.5" y="3" width="7" height="4" rx="1" />
    </Icon>
  );
}

export function GlobeIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="8.75" />
      <path d="M3.25 12h17.5M12 3.25c2.3 2.4 3.5 5.3 3.5 8.75s-1.2 6.35-3.5 8.75c-2.3-2.4-3.5-5.3-3.5-8.75S9.7 5.65 12 3.25Z" />
    </Icon>
  );
}

/** Split the pane side by side (a new pane on the right). */
export function SplitRightIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="3.5" y="4.5" width="17" height="15" rx="1.5" />
      <path d="M12 4.5v15" />
    </Icon>
  );
}

/** Split the pane top and bottom (a new pane below). */
export function SplitDownIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="3.5" y="4.5" width="17" height="15" rx="1.5" />
      <path d="M3.5 12h17" />
    </Icon>
  );
}

/** Actions menu (three stacked dots). */
export function MoreIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 5.5h.01M12 12h.01M12 18.5h.01" strokeWidth={3} />
    </Icon>
  );
}

/** The terminal rang its bell while you were elsewhere. */
export function BellIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M6.5 16.5V11a5.5 5.5 0 0 1 11 0v5.5l1.5 2H5l1.5-2Z" />
      <path d="M10 20.5a2.2 2.2 0 0 0 4 0" />
    </Icon>
  );
}

/** Retry / reconnect now. */
export function RetryIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3" />
      <path d="M19.5 4.5v4h-4" />
    </Icon>
  );
}

/** A terminal window (empty panes, the palette's session rows). */
export function TerminalIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="3.5" y="4.5" width="17" height="15" rx="1.5" />
      <path d="m7.5 9.5 3 2.5-3 2.5M12.5 15h4" />
    </Icon>
  );
}

/** Search field mark. */
export function SearchIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="10.5" cy="10.5" r="6" />
      <path d="m15 15 4.5 4.5" />
    </Icon>
  );
}

/**
 * Collapse the session sidebar: a panel with its left column and, inside the frame, a chevron
 * pointing where the column goes (never a bare arrow, which would read as "back").
 */
export function PanelLeftCloseIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
      <path d="M9.5 4.5v15" />
      <path d="m16.25 9.5-2.5 2.5 2.5 2.5" />
    </Icon>
  );
}

/** Expand the session sidebar: the same panel with the chevron pointing out. */
export function PanelLeftOpenIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
      <path d="M9.5 4.5v15" />
      <path d="m13.75 9.5 2.5 2.5-2.5 2.5" />
    </Icon>
  );
}

/** Settings (a gear). */
export function SettingsIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 3.5v2M12 18.5v2M3.5 12h2M18.5 12h2M6 6l1.4 1.4M16.6 16.6 18 18M6 18l1.4-1.4M16.6 7.4 18 6" />
    </Icon>
  );
}

/** Activity (a pulse line). */
export function ActivityIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M3.5 12h3.6l2.4-6 4 12 2.4-6h4.6" />
    </Icon>
  );
}

/** Administration (people). */
export function UsersIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="9.5" cy="8.5" r="3.25" />
      <path d="M3.75 19.5a5.75 5.75 0 0 1 11.5 0" />
      <path d="M16 5.6a3.25 3.25 0 0 1 0 5.8M17.5 14.2a5.75 5.75 0 0 1 2.75 5.3" />
    </Icon>
  );
}

/** Account (a person). */
export function UserIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="8.5" r="3.5" />
      <path d="M5.5 19.75a6.5 6.5 0 0 1 13 0" />
    </Icon>
  );
}

/** Languages (two overlapping speech marks). */
export function LanguageIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4 6h9M8.5 4v2M11.5 6c-.6 3.6-3 6.6-6.5 8.5M6.5 9.5c1 2.2 2.8 4 5 5.2" />
      <path d="m13 20 3.5-8 3.5 8M14.3 17h4.4" />
    </Icon>
  );
}
