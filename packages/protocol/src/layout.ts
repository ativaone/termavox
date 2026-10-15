import { z } from 'zod';

/** Workspace layout persisted per user (plan §9). */
export type PaneNode =
  | { type: 'leaf'; id: string; sessionId: string | null }
  | {
      type: 'split';
      id: string;
      direction: 'row' | 'column';
      sizes: number[];
      children: PaneNode[];
    };

const nodeId = z.string().min(1).max(64);

export const PaneNode: z.ZodType<PaneNode> = z.lazy(() =>
  z.union([
    z.object({
      type: z.literal('leaf'),
      id: nodeId,
      sessionId: z.string().min(1).max(64).nullable(),
    }),
    z
      .object({
        type: z.literal('split'),
        id: nodeId,
        direction: z.enum(['row', 'column']),
        sizes: z.array(z.number().positive()).min(2).max(8),
        children: z.array(PaneNode).min(2).max(8),
      })
      .refine((s) => s.sizes.length === s.children.length, 'sizes must match children'),
  ]),
);

export const Tab = z.object({
  id: nodeId,
  title: z.string().max(120).optional(),
  activePaneId: nodeId,
  root: PaneNode,
});
export type Tab = z.infer<typeof Tab>;

export const WorkspaceLayout = z.object({
  version: z.literal(1),
  activeTabId: nodeId.nullable(),
  tabs: z.array(Tab).max(32),
});
export type WorkspaceLayout = z.infer<typeof WorkspaceLayout>;

export const EMPTY_LAYOUT: WorkspaceLayout = { version: 1, activeTabId: null, tabs: [] };
