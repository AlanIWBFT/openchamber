import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { cn } from '@/lib/utils';
import { BlockLine } from './BlockLine';

const IDENTITY_KEYS = new Set(['id', 'identifier', 'title', 'name']);

const isRecord = (value: unknown): value is Record<string, unknown> => (
    typeof value === 'object' && value !== null && !Array.isArray(value)
);

const formatKey = (key: string) => key
    .replace(/([A-Z])/g, ' $1')
    .replace(/[_-]/g, ' ')
    .replace(/^./, (character) => character.toUpperCase());

const getIdentity = (record: Record<string, unknown>): string | null => {
    const id = typeof record.id === 'string' ? record.id : typeof record.identifier === 'string' ? record.identifier : '';
    const title = typeof record.title === 'string' ? record.title : typeof record.name === 'string' ? record.name : '';
    if (id && title) return `${id} · ${title}`;
    return title || id || null;
};

const isUrl = (value: string): boolean => {
    try {
        const url = new URL(value);
        return url.protocol === 'http:' || url.protocol === 'https:';
    } catch {
        return false;
    }
};

const JsonSummaryValue = React.memo(({
    value,
    label,
    depth,
    reserveActions = false,
}: {
    value: unknown;
    label?: string;
    depth: number;
    reserveActions?: boolean;
}) => {
    if (Array.isArray(value)) {
        const summary = label ? `${formatKey(label)} (${value.length})` : `(${value.length})`;
        return (
            <details open={depth < 2} className="group/json-summary col-span-full min-w-0">
                <summary className={cn('flex cursor-pointer list-none items-center gap-1.5 py-0.5 typography-meta text-foreground hover:text-muted-foreground', reserveActions && 'min-h-6 pe-28')}>
                    <Icon name="arrow-right-s" className="h-3.5 w-3.5 shrink-0 transition-transform group-open/json-summary:rotate-90 rtl:group-open/json-summary:-rotate-90" />
                    <span className="min-w-0 truncate font-medium">{summary}</span>
                </summary>
                <div className="relative ms-1 ps-3 pb-1">
                    <BlockLine bottomOffset={4} />
                    <div className="min-w-0 overflow-x-auto">
                    {value.map((item, index) => <JsonSummaryValue key={index} value={item} depth={depth + 1} />)}
                    </div>
                </div>
            </details>
        );
    }

    if (isRecord(value)) {
        const identity = getIdentity(value);
        const entries = Object.entries(value).filter(([key]) => !IDENTITY_KEYS.has(key));
        const summary = label ? `${formatKey(label)}${identity ? ` · ${identity}` : ''}` : identity;
        const content = (
            <div className="grid min-w-0 grid-cols-[fit-content(40%)_minmax(0,1fr)] gap-x-2">
                {entries.map(([key, entry], index) => (
                    <JsonSummaryValue key={key} label={key} value={entry} depth={depth + 1} reserveActions={reserveActions && depth === 0 && !identity && index === 0} />
                ))}
            </div>
        );

        if (!label && depth === 0) {
            return <div>{identity ? <div className={cn('py-0.5 typography-meta font-medium text-foreground [overflow-wrap:anywhere]', reserveActions && 'min-h-6 pe-28')}>{identity}</div> : null}{content}</div>;
        }

        return (
            <details open={depth < 2} className="group/json-summary col-span-full min-w-0">
                <summary className={cn('flex cursor-pointer list-none items-center gap-1.5 py-0.5 typography-meta text-foreground hover:text-muted-foreground', reserveActions && 'min-h-6 pe-28')}>
                    <Icon name="arrow-right-s" className="h-3.5 w-3.5 shrink-0 transition-transform group-open/json-summary:rotate-90 rtl:group-open/json-summary:-rotate-90" />
                    <span className="min-w-0 truncate font-medium">{summary ?? (label ? formatKey(label) : '{}')}</span>
                </summary>
                <div className="relative ms-1 ps-3 pb-1">
                    <BlockLine bottomOffset={4} />
                    {content}
                </div>
            </details>
        );
    }

    const text = value === null ? 'null' : typeof value === 'boolean' ? (value ? 'true' : 'false') : String(value);
    const renderedValue = typeof value === 'string' && isUrl(value) ? (
        <a href={value} target="_blank" rel="noopener noreferrer" className="truncate text-[var(--status-info)] underline underline-offset-2 hover:opacity-80" title={value}>{value}</a>
    ) : (
        <span className={cn('min-w-0', label !== undefined || reserveActions ? '[overflow-wrap:anywhere]' : 'whitespace-pre', value === null ? 'text-muted-foreground' : 'text-foreground')}>{text}</span>
    );

    return (
        <div className={cn('min-w-0 py-0.5 typography-meta', label !== undefined ? 'col-span-full grid grid-cols-subgrid' : 'font-mono', reserveActions && 'min-h-6 pe-28')}>
            {label !== undefined ? <span className="truncate text-muted-foreground" title={label}>{formatKey(label)}</span> : null}
            {renderedValue}
        </div>
    );
});

JsonSummaryValue.displayName = 'JsonSummaryValue';

export const JsonSummaryView = React.memo(({ data, actions }: { data: unknown; actions?: React.ReactNode }) => (
    <div className={cn('relative min-w-0', actions && 'min-h-6')}>
        {actions ? <div className="absolute inset-e-0 top-0 z-10">{actions}</div> : null}
        <div className="min-w-0 overflow-x-auto">
            <JsonSummaryValue value={data} depth={0} reserveActions={Boolean(actions)} />
        </div>
    </div>
));

JsonSummaryView.displayName = 'JsonSummaryView';
