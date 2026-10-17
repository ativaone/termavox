import type { ChangeEventHandler, ReactNode } from 'react';
import { cx } from '../ui/cx.ts';
import { Panel, PanelSection } from '../ui/panel.tsx';
import { choiceCardClasses, radioClasses } from '../ui/radio.ts';

/**
 * One numbered section of "Add server" (plan D-27, D-29): a card whose heading carries its step
 * number in a quiet pill (the first-run steps' marker; never the accent, which belongs to
 * selection), one line of context, then the section's fields under a hairline.
 */
export function AddServerSection({
  id,
  step,
  title,
  intro,
  children,
}: {
  id: string;
  step: number;
  title: string;
  intro: string;
  /** The section's fields; without them the card is its heading and intro alone. */
  children?: ReactNode;
}) {
  return (
    <Panel aria-labelledby={id}>
      <PanelSection>
        <div className="flex items-start gap-3">
          <span
            aria-hidden="true"
            className="mt-px inline-flex size-6 shrink-0 items-center justify-center rounded-pill bg-surface-raised font-semibold text-ink-muted text-xs tabular-nums"
          >
            {step}
          </span>
          <div className="flex min-w-0 flex-col gap-1">
            <h2 id={id} className="font-semibold text-ink text-md">
              <span className="sr-only">{step}. </span>
              {title}
            </h2>
            <p className="max-w-[60ch] text-pretty text-base text-ink-muted">{intro}</p>
          </div>
        </div>
      </PanelSection>
      {children ? (
        <PanelSection ruled className="flex flex-col gap-5">
          {children}
        </PanelSection>
      ) : null}
    </Panel>
  );
}

/**
 * A radio drawn as a choice card: title (with an optional tag) over one line of help. A disabled
 * card dims its title and keeps its help (which says why) readable.
 */
export function ChoiceCard({
  name,
  value,
  checked,
  onChange,
  title,
  help,
  tag,
  disabled = false,
}: {
  name: string;
  value: string;
  checked: boolean;
  onChange: ChangeEventHandler<HTMLInputElement>;
  title: string;
  help?: string;
  tag?: ReactNode;
  disabled?: boolean;
}) {
  return (
    <label
      className={choiceCardClasses(
        checked,
        cx(
          'min-w-0 items-start gap-3 px-3.5 py-3',
          disabled && 'cursor-not-allowed hover:bg-transparent',
        ),
      )}
    >
      <input
        type="radio"
        name={name}
        value={value}
        checked={checked}
        onChange={onChange}
        disabled={disabled}
        className={radioClasses('sm', 'mt-0.5')}
      />
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className={cx('font-medium text-base', disabled ? 'text-ink-faint' : 'text-ink')}>
            {title}
          </span>
          {tag}
        </span>
        {help ? <span className="text-pretty text-ink-muted text-sm">{help}</span> : null}
      </span>
    </label>
  );
}
