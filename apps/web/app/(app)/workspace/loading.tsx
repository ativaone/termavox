import { Skeleton } from '../../../components/ui/spinner.tsx';

/** The workspace frame with placeholder strips while the bay loads (no spinner in content). */
export default function WorkspaceLoading() {
  return (
    <div aria-busy="true" className="flex h-dvh bg-board-0">
      <div className="surface-board flex w-full flex-col gap-5 bg-board-1 px-3 pt-4 md:w-(--bay-width)">
        <Skeleton className="h-7 w-32" />
        <Skeleton className="h-9 w-full" />
        <div className="flex flex-col gap-1.5 pe-1">
          <Skeleton className="h-5 w-24" />
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
        </div>
      </div>
      <div className="hidden flex-1 flex-col bg-board-2 px-1.5 pb-1.5 md:flex">
        <div className="h-(--tabbar-height)" />
        <div className="flex-1 rounded-[3px] bg-pane" />
      </div>
    </div>
  );
}
