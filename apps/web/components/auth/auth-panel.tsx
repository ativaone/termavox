import { type ReactNode, useId } from 'react';
import { cx } from '../ui/cx.ts';
import { Panel, PanelSection } from '../ui/panel.tsx';

/** The single stock sheet every auth surface is built on: heading, form, optional footer row. */
export function AuthPanel({
  title,
  intro,
  footer,
  wide = false,
  children,
}: {
  title: string;
  intro?: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
  children: ReactNode;
}) {
  const titleId = useId();
  return (
    <Panel
      aria-labelledby={titleId}
      className={cx('w-full self-start', wide ? 'max-w-[30rem]' : 'max-w-[25rem]')}
    >
      <PanelSection>
        <h1 id={titleId} className="font-semibold text-ink text-xl">
          {title}
        </h1>
        {intro ? <p className="mt-1.5 text-pretty text-base text-ink-muted">{intro}</p> : null}
      </PanelSection>
      <PanelSection ruled>{children}</PanelSection>
      {footer ? (
        <PanelSection
          ruled
          className="flex flex-wrap items-center justify-between gap-2 py-3 sm:py-3"
        >
          {footer}
        </PanelSection>
      ) : null}
    </Panel>
  );
}
