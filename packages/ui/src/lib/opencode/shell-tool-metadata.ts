import type { ToolMetadata } from '../toolHelpers';

export const shellMetadata = {
  shell: {
    displayName: 'Shell Command', category: 'system', outputLanguage: 'text',
    inputFields: [
      { key: 'command', label: 'Command', type: 'command', language: 'bash' },
      { key: 'description', label: 'Description', type: 'text' },
      { key: 'timeout', label: 'Timeout (ms)', type: 'text' },
      { key: 'background', label: 'Background', type: 'text' },
    ],
  },
  exec_command: {
    displayName: 'Shell Command', category: 'system', outputLanguage: 'text',
    inputFields: [
      { key: 'cmd', label: 'Command', type: 'command', language: 'bash' },
      { key: 'workdir', label: 'Working Directory', type: 'file' },
      { key: 'yield_time_ms', label: 'Yield Time (ms)', type: 'text' },
    ],
  },
  write_stdin: { displayName: 'Process Input', category: 'system', outputLanguage: 'text', inputFields: [] },
  terminate_exec: { displayName: 'Process Termination', category: 'system', outputLanguage: 'text', inputFields: [] },
} satisfies Record<string, ToolMetadata>;
