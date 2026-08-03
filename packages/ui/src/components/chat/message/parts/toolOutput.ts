const ensureLine = (lines: string[][], row: number): void => {
    while (lines.length <= row) {
        lines.push([]);
    }
};

const writeTerminalCharacter = (lines: string[][], row: number, column: number, character: string): void => {
    ensureLine(lines, row);
    const line = lines[row];
    while (line.length < column) {
        line.push(' ');
    }
    line[column] = character;
};

export const renderTerminalOutput = (output: string): string => {
    if (!output.includes('\u001B') && !output.includes('\r') && !output.includes('\b')) {
        return output;
    }

    const lines: string[][] = [[]];
    let row = 0;
    let column = 0;

    for (let index = 0; index < output.length; index += 1) {
        const character = output[index];

        if (character === '\n') {
            row += 1;
            column = 0;
            ensureLine(lines, row);
            continue;
        }
        if (character === '\r') {
            column = 0;
            continue;
        }
        if (character === '\b') {
            column = Math.max(0, column - 1);
            continue;
        }
        if (character !== '\u001B') {
            writeTerminalCharacter(lines, row, column, character);
            column += 1;
            continue;
        }

        const nextCharacter = output[index + 1];
        if (nextCharacter === '[') {
            const sequenceStart = index + 2;
            let sequenceEnd = sequenceStart;
            while (sequenceEnd < output.length && !/[\x40-\x7E]/.test(output[sequenceEnd])) {
                sequenceEnd += 1;
            }
            if (sequenceEnd === output.length) {
                break;
            }

            const command = output[sequenceEnd];
            const parameters = output.slice(sequenceStart, sequenceEnd).split(';').map((value) => Number.parseInt(value, 10) || 0);
            const count = parameters[0] || 1;
            if (command === 'A') {
                row = Math.max(0, row - count);
            } else if (command === 'B') {
                row += count;
                ensureLine(lines, row);
            } else if (command === 'C') {
                column += count;
            } else if (command === 'D') {
                column = Math.max(0, column - count);
            } else if (command === 'G') {
                column = Math.max(0, count - 1);
            } else if (command === 'H' || command === 'f') {
                row = Math.max(0, (parameters[0] || 1) - 1);
                column = Math.max(0, (parameters[1] || 1) - 1);
                ensureLine(lines, row);
            } else if (command === 'K') {
                ensureLine(lines, row);
                const line = lines[row];
                const mode = parameters[0];
                if (mode === 1) {
                    for (let i = 0; i <= column && i < line.length; i += 1) {
                        line[i] = ' ';
                    }
                } else if (mode === 2) {
                    lines[row] = [];
                } else {
                    line.length = Math.min(line.length, column);
                }
            }
            index = sequenceEnd;
            continue;
        }

        if (nextCharacter === ']') {
            const terminator = output.indexOf('\u0007', index + 2);
            const stringTerminator = output.indexOf('\u001B\\', index + 2);
            const end = terminator === -1
                ? stringTerminator
                : stringTerminator === -1
                    ? terminator
                    : Math.min(terminator, stringTerminator);
            if (end === -1) {
                break;
            }
            index = output[end] === '\u0007' ? end : end + 1;
            continue;
        }

        index += 1;
    }

    return lines.map((line) => line.join('')).join('\n');
};

export const getToolOutput = (
    tool: string,
    stateOutput: unknown,
    metadataOutput: unknown,
    status?: string,
): string | undefined => {
    const isBash = tool === 'bash';
    const shouldNormalize = isBash && status !== 'running';

    if (typeof stateOutput === 'string') {
        return shouldNormalize ? renderTerminalOutput(stateOutput) : stateOutput;
    }

    if (isBash && typeof metadataOutput === 'string' && metadataOutput.length > 0) {
        return shouldNormalize ? renderTerminalOutput(metadataOutput) : metadataOutput;
    }

    return undefined;
};

export const getStreamingOutputAppend = (previous: string, next: string): string | undefined => {
    return next.startsWith(previous) ? next.slice(previous.length) : undefined;
};
