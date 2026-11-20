import { summarizeLiveActivity } from './liveActivitySummary';
import type { ChatMessageEntry, TurnChangedFile } from './types';

export const projectTurnChangedFiles = (
    assistantMessages: ChatMessageEntry[],
): TurnChangedFile[] | undefined => {
    const summary = summarizeLiveActivity(assistantMessages);

    const files = summary.changedFiles.map((change): TurnChangedFile => (
        change.additions !== undefined && change.deletions !== undefined
            ? { file: change.path, additions: change.additions, deletions: change.deletions, inTurnDiff: true }
            : { file: change.path, inTurnDiff: true }
    ));

    return files.length > 0 ? files : undefined;
};
