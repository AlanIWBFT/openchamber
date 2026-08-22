import assert from 'node:assert/strict';
import test from 'node:test';

import { parsePeSubsystem, WINDOWS_GUI_SUBSYSTEM } from './pe-subsystem.mjs';

const makePe = ({ magic = 0x20b, subsystem = WINDOWS_GUI_SUBSYSTEM, optionalHeaderSize = 0xf0 } = {}) => {
  const binary = Buffer.alloc(512);
  const peOffset = 0x80;
  const optionalHeaderOffset = peOffset + 24;
  binary.writeUInt16LE(0x5a4d, 0);
  binary.writeUInt32LE(peOffset, 0x3c);
  binary.writeUInt32LE(0x00004550, peOffset);
  binary.writeUInt16LE(optionalHeaderSize, peOffset + 20);
  binary.writeUInt16LE(magic, optionalHeaderOffset);
  binary.writeUInt16LE(subsystem, optionalHeaderOffset + 68);
  return binary;
};

test('reads the subsystem from PE32 and PE32+ executables', () => {
  assert.equal(parsePeSubsystem(makePe({ magic: 0x10b })), WINDOWS_GUI_SUBSYSTEM);
  assert.equal(parsePeSubsystem(makePe({ magic: 0x20b, subsystem: 3 })), 3);
});

test('rejects invalid and truncated PE headers', () => {
  assert.throws(() => parsePeSubsystem(Buffer.alloc(64)), /valid DOS header/);
  assert.throws(() => parsePeSubsystem(makePe({ optionalHeaderSize: 32 })), /truncated PE optional header/);
});
