import React from 'react';

import { Button } from '@/components/ui/button';
import { Icon } from "@/components/icon/Icon";
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';

interface ScrollToBottomButtonProps {
    visible: boolean;
    /** The session is still streaming: the pill carries the activity signal
        while the floating status row is hidden away from the live edge. */
    working?: boolean;
    onClick: () => void;
}

const ScrollToBottomButton: React.FC<ScrollToBottomButtonProps> = ({ visible, working = false, onClick }) => {
    const { t } = useI18n();
    return (
        <div
            className={cn(
                // Left-aligned to match the status row it stands in for.
                'absolute bottom-full left-2 mb-2 transition-all duration-150',
                visible ? 'opacity-100 translate-y-0 scale-100 pointer-events-auto' : 'opacity-0 translate-y-2 scale-95 pointer-events-none',
            )}
        >
            <Button
                variant="ghost"
                size="sm"
                onClick={onClick}
                className="oc-glass-popover oc-glass-floating relative size-8 rounded-full [corner-shape:round] p-0 shadow-none"
                aria-label={t('chat.scrollToBottom.aria')}
            >
                <Icon name="arrow-down" className="h-4 w-4" />
                {working ? (
                    <span
                        aria-hidden
                        className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-primary animate-pulse"
                    />
                ) : null}
            </Button>
        </div>
    );
};

export default React.memo(ScrollToBottomButton);
