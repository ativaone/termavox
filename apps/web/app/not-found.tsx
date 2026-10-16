import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { useId } from 'react';
import { ButtonLink } from '../components/ui/button.tsx';
import { EmptyState } from '../components/ui/empty-state.tsx';
import { Panel } from '../components/ui/panel.tsx';
import { Wordmark } from '../components/ui/wordmark.tsx';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('meta');
  return { title: t('notFound') };
}

function NotFoundPanel({ title, body, home }: { title: string; body: string; home: string }) {
  const titleId = useId();
  return (
    <Panel aria-labelledby={titleId} className="w-full max-w-[25rem] p-6">
      <EmptyState
        titleId={titleId}
        title={title}
        body={body}
        action={
          <ButtonLink href="/workspace" variant="primary">
            {home}
          </ButtonLink>
        }
      />
    </Panel>
  );
}

/** Unknown addresses, and /setup once an administrator exists. */
export default async function NotFound() {
  const t = await getTranslations('notFound');
  return (
    <div className="surface-board flex min-h-dvh flex-col items-center gap-8 bg-board-0 px-4 pt-10 sm:pt-16">
      <Wordmark />
      <main className="flex w-full justify-center">
        <NotFoundPanel title={t('title')} body={t('body')} home={t('home')} />
      </main>
    </div>
  );
}
