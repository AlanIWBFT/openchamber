import { getToolDiffPreviewText, TOOL_DIFF_PREVIEW_MAX_CHARS } from './toolDiffPreview';

// A JSON escape occupies at most six UTF-16 units per decoded unit.
export const PATCH_INPUT_PREVIEW_RAW_LIMIT = TOOL_DIFF_PREVIEW_MAX_CHARS * 6 + 128;

/** Read the patch tool's single string argument while its JSON is still arriving. */
export function patchInputPreview(raw: string): string {
    const start = /^\s*\{\s*"patchText"\s*:\s*"/.exec(raw);
    if (!start) return '';
    const from = start[0].length;
    const end = Math.min(raw.length, PATCH_INPUT_PREVIEW_RAW_LIMIT);
    let cursor = from;
    let closed = false;
    for (; cursor < end; cursor += 1) {
        if (raw[cursor] === '"') {
            closed = true;
            break;
        }
        if (raw[cursor] !== '\\') continue;
        const escapeLength = raw[cursor + 1] === 'u' ? 6 : 2;
        if (cursor + escapeLength > end) break;
        cursor += escapeLength - 1;
    }
    try {
        const text: string = JSON.parse(`"${raw.slice(from, cursor)}"`);
        // Keep an unfinished line (including a split surrogate pair) off screen.
        const complete = closed ? text : text.slice(0, text.lastIndexOf('\n') + 1);
        return getToolDiffPreviewText(complete);
    } catch {
        return '';
    }
}
