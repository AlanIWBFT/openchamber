import * as React from 'react';

export const useActivationOverscan = (enabled: boolean, normalOverscan: number): number => {
    const [recoveryStep, setRecoveryStep] = React.useState(0);

    React.useEffect(() => {
        if (!enabled) {
            setRecoveryStep(0);
            return;
        }

        let halfOverscanFrame: number | undefined;
        const paintOpportunityFrame = window.requestAnimationFrame(() => {
            halfOverscanFrame = window.requestAnimationFrame(() => {
                React.startTransition(() => setRecoveryStep(1));
            });
        });
        return () => {
            window.cancelAnimationFrame(paintOpportunityFrame);
            if (halfOverscanFrame !== undefined) window.cancelAnimationFrame(halfOverscanFrame);
        };
    }, [enabled]);

    React.useEffect(() => {
        if (!enabled || recoveryStep !== 1) return;
        const normalOverscanFrame = window.requestAnimationFrame(() => {
            React.startTransition(() => setRecoveryStep(2));
        });
        return () => window.cancelAnimationFrame(normalOverscanFrame);
    }, [enabled, recoveryStep]);

    if (!enabled || recoveryStep >= 2) return normalOverscan;
    return recoveryStep === 0 ? 0 : Math.ceil(normalOverscan / 2);
};
