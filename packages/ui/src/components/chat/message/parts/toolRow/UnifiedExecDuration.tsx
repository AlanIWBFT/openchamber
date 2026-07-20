import { useDurationTickerNow } from '@/hooks/useDurationTicker';
import { useI18n } from '@/lib/i18n';
import type { ToolPart } from '@/lib/opencode/model';
import { formatUnifiedExecDuration, getUnifiedExecStatus, type UnifiedExecMetadata } from '../../unifiedExec';
import { TOOL_ERROR_TITLE_STYLE } from './toolRowStyles';

export function UnifiedExecDuration({ metadata, active, stateStatus }: {
    metadata: UnifiedExecMetadata; active: boolean; stateStatus: ToolPart['state']['status'];
}) {
    const { locale, t } = useI18n();
    const status = getUnifiedExecStatus(metadata, useDurationTickerNow(active), stateStatus);
    if (!status) return null;
    const duration = status.durationMs === undefined ? undefined : formatUnifiedExecDuration(status.durationMs, locale);
    const label = () => {
        switch (status.kind) {
            case 'error': return duration ? t('chat.toolPart.unifiedExec.status.errorWithDuration', { duration }) : t('chat.toolPart.unifiedExec.status.error');
            case 'running': return duration ? t('chat.toolPart.unifiedExec.status.runningWithDuration', { duration }) : t('chat.toolPart.unifiedExec.status.running');
            case 'terminated': return duration ? t('chat.toolPart.unifiedExec.status.terminatedWithDuration', { duration }) : t('chat.toolPart.unifiedExec.status.terminated');
            case 'exited': return duration ? t('chat.toolPart.unifiedExec.status.exitedWithDuration', { code: status.exitCode ?? '', duration }) : t('chat.toolPart.unifiedExec.status.exited', { code: status.exitCode ?? '' });
            case 'completed': return duration ? t('chat.toolPart.unifiedExec.status.completedWithDuration', { duration }) : t('chat.toolPart.unifiedExec.status.completed');
        }
    };
    return <span style={status.error ? TOOL_ERROR_TITLE_STYLE : undefined}>{label()}</span>;
}
