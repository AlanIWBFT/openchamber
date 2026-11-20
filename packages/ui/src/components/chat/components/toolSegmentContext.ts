import { createContext } from 'react';
import type { ToolSegment, toolSegments } from '../lib/turns/toolSegments';

export const SegmentContext = createContext<{
    index: ReturnType<typeof toolSegments>;
    preview: ToolSegment | undefined;
    expanded: (id: string) => boolean;
    toggle: (ids: readonly string[], expanded: boolean) => void;
} | null>(null);
