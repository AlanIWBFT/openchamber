import type { OpencodeClient, Session } from '@opencode-ai/sdk/v2';
import { flattenAssistantTextParts } from '@/lib/messages/messageText';
import { createMessageOrderState, decodeStoredMessageRecords, sortMessages, sortParts } from '@/sync/message-order';
import { getMultiRunIdentity, isFusionSource, type MultiRunIdentity } from './identity';

export type FusionSource = {
  session: Session;
  directory: string | null;
  projectDirectory: string | null;
  identity: MultiRunIdentity;
};

/** Revalidate selected IDs before reading their output. A failed read is not an empty result. */
export async function loadFusionOutputs(
  client: OpencodeClient,
  sources: FusionSource[],
  anchor: MultiRunIdentity,
  assertCurrent: () => void,
): Promise<Array<{ source: FusionSource; text: string }>> {
  const outputs = await Promise.all(sources.map(async (source) => {
    assertCurrent();
    const directory = source.directory ?? source.session.directory;
    const current = await client.session.get({ sessionID: source.session.id, directory }, { throwOnError: true });
    assertCurrent();
    if (!current.data || !isFusionSource(anchor, getMultiRunIdentity(current.data, source.projectDirectory ?? current.data.directory))) {
      throw new Error('Fusion source membership changed');
    }
    const result = await client.session.messages({ sessionID: source.session.id, directory, limit: 50 }, { throwOnError: true });
    assertCurrent();
    if (!Array.isArray(result.data)) throw new Error('Fusion source messages unavailable');
    const decoded = decodeStoredMessageRecords(result.data, new Set(), source.session.id);
    const order = createMessageOrderState();
    for (const [id, seq] of decoded.messageSeq) order.message.set(id, seq);
    for (const [id, seq] of decoded.partSeq) order.part.set(id, seq);
    const byID = new Map(decoded.records.map((record) => [record.info.id, record]));
    const messages = sortMessages(decoded.records.map((record) => record.info), order);
    let text = '';
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const record = byID.get(messages[index].id);
      if (!record || record.info.role !== 'assistant') continue;
      text = flattenAssistantTextParts(sortParts(record.parts, order)).trim();
      break;
    }
    return { source: { ...source, session: current.data }, text };
  }));
  assertCurrent();
  return outputs.filter((output) => output.text.length > 0);
}
