import { Skeleton } from '../../../components/ui/spinner.tsx';

/** The workspace frame with placeholder rows while the session list loads (no spinner in content). */
export default function WorkspaceLoading() {
  return (
    <div aria-busy="true" className="ground-glow flex h-dvh">
      <div className="flex w-full flex-col gap-4 px-3 pt-3 md:w-(--sidebar-width)">
        <div className="flex h-10 items-center gap-2.5 px-1">
          <Skeleton className="size-7 rounded-sm" />
          <Skeleton className="h-4 w-24" />
        </div>
        <Skeleton className="h-10 w-full rounded-control" />
        <div className="flex flex-col gap-1 pt-2">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-12 w-full rounded-row" />
          <Skeleton className="h-12 w-full rounded-row" />
          <Skeleton className="h-12 w-full rounded-row" />
        </div>
      </div>
      <div className="hidden flex-1 flex-col pe-2 pb-2 md:flex">
        <div className="h-(--tabbar-height)" />
        <div className="flex-1 rounded-row border border-line bg-pane" />
      </div>
    </div>
  );
}
