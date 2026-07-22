import { describe, expect, it } from 'bun:test'
import { applyDirectoryEvent } from '../event-reducer'
import { INITIAL_STATE } from '../types'
import { createMessageOrderState } from '../message-order'

describe('applyDirectoryEvent', () => {
  it('does not duplicate overlapping delta text after a newer part.updated replaces an older one', () => {
    const state = structuredClone(INITIAL_STATE)
    const messageID = 'msg-1'
    const partID = 'part-1'
    const options = { order: createMessageOrderState() }

    applyDirectoryEvent(state, {
      type: 'message.part.updated', seq: 1,
      properties: {
        part: {
          id: partID,
          sessionID: 'ses-1',
          type: 'text',
          messageID,
          text: 'Fix typo in ToolOutputDialog — ',
        },
      },
    }, options)

    applyDirectoryEvent(state, {
      type: 'message.part.updated', seq: 1,
      properties: {
        part: {
          id: partID,
          sessionID: 'ses-1',
          type: 'text',
          messageID,
          text: 'Fix typo in ToolOutputDialog — toolFailedToReadDiagram vs toolFailedReadDiagram • Let me fix it.',
        },
      },
    }, options)

    applyDirectoryEvent(state, {
      type: 'message.part.delta',
      properties: {
        messageID,
        partID,
        field: 'text',
        delta: 'toolFailedToReadDiagram vs toolFailedReadDiagram • Let me fix it.',
      },
    }, options)

    expect(state.part[messageID]).toHaveLength(1)
    expect(state.part[messageID]?.[0]?.text).toBe(
      'Fix typo in ToolOutputDialog — toolFailedToReadDiagram vs toolFailedReadDiagram • Let me fix it.',
    )
  })

  it('appends only the non-overlapping suffix of a streaming delta', () => {
    const state = structuredClone(INITIAL_STATE)
    const messageID = 'msg-2'
    const partID = 'part-2'
    const options = { order: createMessageOrderState() }

    applyDirectoryEvent(state, {
      type: 'message.part.updated', seq: 1,
      properties: {
        part: {
          id: partID,
          sessionID: 'ses-1',
          type: 'text',
          messageID,
          text: 'toolFailedToReadDiagram vs toolFailedRead',
        },
      },
    }, options)

    applyDirectoryEvent(state, {
      type: 'message.part.updated', seq: 1,
      properties: {
        part: {
          id: partID,
          sessionID: 'ses-1',
          type: 'text',
          messageID,
          text: 'toolFailedToReadDiagram vs toolFailedReadDiagra',
        },
      },
    }, options)

    applyDirectoryEvent(state, {
      type: 'message.part.delta',
      properties: {
        messageID,
        partID,
        field: 'text',
        delta: 'Diagram • Let me fix it.',
      },
    }, options)

    expect(state.part[messageID]?.[0]?.text).toBe(
      'toolFailedToReadDiagram vs toolFailedReadDiagram • Let me fix it.',
    )
  })

  it('appends a non-overlapping delta unchanged', () => {
    const state = structuredClone(INITIAL_STATE)
    const messageID = 'msg-3'
    const partID = 'part-3'
    const options = { order: createMessageOrderState() }

    applyDirectoryEvent(state, {
      type: 'message.part.updated', seq: 1,
      properties: {
        part: {
          id: partID,
          sessionID: 'ses-1',
          type: 'text',
          messageID,
          text: 'PR comment done — ',
        },
      },
    }, options)

    applyDirectoryEvent(state, {
      type: 'message.part.delta',
      properties: {
        messageID,
        partID,
        field: 'text',
        delta: 'Let me fix it.',
      },
    }, options)

    expect(state.part[messageID]?.[0]?.text).toBe('PR comment done — Let me fix it.')
  })

  it('preserves legitimate repeated output when no updated-to-delta dedupe window is active', () => {
    const state = structuredClone(INITIAL_STATE)
    const messageID = 'msg-4'
    const partID = 'part-4'
    const options = { order: createMessageOrderState() }

    applyDirectoryEvent(state, {
      type: 'message.part.updated', seq: 1,
      properties: {
        part: {
          id: partID,
          sessionID: 'ses-1',
          type: 'text',
          messageID,
          text: 'ha',
        },
      },
    }, options)

    applyDirectoryEvent(state, {
      type: 'message.part.delta',
      properties: {
        messageID,
        partID,
        field: 'text',
        delta: 'ha',
      },
    }, options)

    expect(state.part[messageID]?.[0]?.text).toBe('haha')
  })

  it('does not let a stale running tool update overwrite a completed tool part', () => {
    const state = structuredClone(INITIAL_STATE)
    const messageID = 'msg-5'
    const partID = 'part-5'
    const options = { order: createMessageOrderState() }

    applyDirectoryEvent(state, {
      type: 'message.part.updated', seq: 1,
      properties: {
        part: {
          id: partID,
          sessionID: 'ses-1',
          type: 'tool',
          messageID,
          tool: 'apply_patch',
          state: {
            status: 'completed',
            time: {
              start: 10,
              end: 20,
            },
          },
        },
      },
    }, options)

    applyDirectoryEvent(state, {
      type: 'message.part.updated', seq: 1,
      properties: {
        part: {
          id: partID,
          sessionID: 'ses-1',
          type: 'tool',
          messageID,
          tool: 'apply_patch',
          state: {
            status: 'running',
            time: {
              start: 10,
            },
          },
        },
      },
    }, options)

    expect(state.part[messageID]?.[0]?.state?.status).toBe('completed')
    expect(state.part[messageID]?.[0]?.state?.time?.end).toBe(20)
  })
})
