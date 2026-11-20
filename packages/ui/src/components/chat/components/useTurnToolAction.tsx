import { useContext, useMemo } from 'react';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import type { MessageExtraAction } from '../message/MessageBody';
import { hiddenToolCount } from '../lib/turns/toolSegments';
import { SegmentContext } from './toolSegmentContext';

export function useTurnToolAction(isPrompt: boolean): MessageExtraAction | undefined {
    const segments = useContext(SegmentContext);
    const { t } = useI18n();
    return useMemo(() => {
        if (!isPrompt || !segments) return;
        const ids = segments.index.segments.filter(segment => hiddenToolCount(segment, segments.preview)).map(segment => segment.id);
        if (!ids.length) return;
        const expand = ids.some(id => !segments.expanded(id));
        return {
            id: 'turn-tool-records',
            label: t(expand ? 'chat.liveActivity.expandTools' : 'chat.liveActivity.collapseTools'),
            icon: <Icon name="stack" className="size-3.5" />,
            onSelect: () => segments.toggle(ids, expand),
        };
    }, [isPrompt, segments, t]);
}
