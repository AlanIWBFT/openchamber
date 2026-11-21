import type { ReadableStream } from 'node:stream/web';

export type NodeFetchResponse = Omit<Response, 'body'> & {
  readonly body: ReadableStream<Uint8Array<ArrayBuffer>> | null;
};

export interface NodeFetch {
  (input: string, init?: RequestInit): Promise<NodeFetchResponse>;
}
