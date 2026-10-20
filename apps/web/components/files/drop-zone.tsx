'use client';

import { useTranslations } from 'next-intl';
import { type DragEvent, useRef, useState } from 'react';
import { displayName } from '../../lib/files/display-name.ts';
import { UploadIcon } from '../icons/index.tsx';

function carriesFiles(event: DragEvent): boolean {
  return [...event.dataTransfer.types].includes('Files');
}

/**
 * Files dragged from the desktop onto the panel. Folders in a drop are counted and left out
 * (folder upload is out of scope, plan D-39); everything else goes to `onFiles`. A depth counter
 * keeps the overlay steady while the pointer crosses the panel's children.
 */
export function useFileDrop({
  enabled,
  onFiles,
}: {
  enabled: boolean;
  onFiles(files: File[], skippedFolders: number): void;
}) {
  const [active, setActive] = useState(false);
  const depth = useRef(0);

  const handlers = {
    onDragEnter: (event: DragEvent) => {
      if (!enabled || !carriesFiles(event)) return;
      event.preventDefault();
      depth.current++;
      setActive(true);
    },
    onDragOver: (event: DragEvent) => {
      if (!enabled || !carriesFiles(event)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
    },
    onDragLeave: (event: DragEvent) => {
      if (!enabled || !carriesFiles(event)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setActive(false);
    },
    onDrop: (event: DragEvent) => {
      depth.current = 0;
      setActive(false);
      if (!enabled || !carriesFiles(event)) return;
      event.preventDefault();
      const files: File[] = [];
      let skipped = 0;
      // Entries must be read during the event: the item list empties once it returns.
      for (const item of [...event.dataTransfer.items]) {
        if (item.kind !== 'file') continue;
        if (item.webkitGetAsEntry?.()?.isDirectory) {
          skipped++;
          continue;
        }
        const file = item.getAsFile();
        if (file) files.push(file);
      }
      onFiles(files, skipped);
    },
  };
  return { active, handlers };
}

/** "Drop to upload to <folder>": a lit card over the whole panel while files hover it. */
export function DropOverlay({ folder }: { folder: string }) {
  const t = useTranslations('files.drop');
  return (
    <div className="pointer-events-none absolute inset-0 z-40 flex items-center justify-center bg-ground-deep/85 p-4">
      <div className="flex w-full max-w-[20rem] flex-col items-center gap-2 rounded-card border border-accent-ring border-dashed bg-accent-soft px-5 py-6 text-center">
        <UploadIcon size={24} className="text-accent" />
        <p className="font-semibold text-ink text-md">{t('title')}</p>
        <p className="max-w-full break-all text-ink-muted text-sm">
          {t.rich('target', {
            folder: displayName(folder).text,
            path: (chunks) => (
              <bdi dir="ltr" className="font-mono text-ink text-xs">
                {chunks}
              </bdi>
            ),
          })}
        </p>
      </div>
    </div>
  );
}
