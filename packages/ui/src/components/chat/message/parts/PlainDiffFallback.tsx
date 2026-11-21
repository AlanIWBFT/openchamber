import React from 'react';

import { getToolDiffPreviewText } from './toolDiffPreview';

export const PlainDiffFallback: React.FC<{ diff: string; colorLines?: boolean }> = ({ diff, colorLines = false }) => {
    const preview = React.useMemo(() => getToolDiffPreviewText(diff), [diff]);

    return (
        <pre
            className="m-0 overflow-auto whitespace-pre-wrap break-words rounded-lg p-2 typography-code"
            style={{
                backgroundColor: 'var(--syntax-background)',
                color: 'var(--syntax-foreground)',
            }}
        >
            {colorLines ? preview.split('\n').map((line, index, lines) => (
                <span key={index} style={{
                    backgroundColor: line.startsWith('+') ? 'var(--tools-edit-added-bg)'
                        : line.startsWith('-') ? 'var(--tools-edit-removed-bg)' : undefined,
                }}>{line}{index < lines.length - 1 ? '\n' : ''}</span>
            )) : preview}
        </pre>
    );
};
