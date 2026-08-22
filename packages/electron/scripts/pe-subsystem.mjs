import fs from 'node:fs';

const DOS_SIGNATURE = 0x5a4d;
const PE_SIGNATURE = 0x00004550;
const PE_OFFSET_LOCATION = 0x3c;
const OPTIONAL_HEADER_OFFSET_FROM_PE = 24;
const SUBSYSTEM_OFFSET_FROM_OPTIONAL_HEADER = 68;
const MINIMUM_OPTIONAL_HEADER_SIZE = SUBSYSTEM_OFFSET_FROM_OPTIONAL_HEADER + 2;
const PE32_MAGIC = 0x10b;
const PE32_PLUS_MAGIC = 0x20b;

export const WINDOWS_GUI_SUBSYSTEM = 2;

export const parsePeSubsystem = (binary, label = 'Windows executable') => {
  if (binary.length < PE_OFFSET_LOCATION + 4 || binary.readUInt16LE(0) !== DOS_SIGNATURE) {
    throw new Error(`${label} does not have a valid DOS header`);
  }

  const peOffset = binary.readUInt32LE(PE_OFFSET_LOCATION);
  if (peOffset > binary.length - OPTIONAL_HEADER_OFFSET_FROM_PE) {
    throw new Error(`${label} has a truncated PE header`);
  }
  if (binary.readUInt32LE(peOffset) !== PE_SIGNATURE) {
    throw new Error(`${label} does not have a valid PE signature`);
  }

  const optionalHeaderSize = binary.readUInt16LE(peOffset + 20);
  const optionalHeaderOffset = peOffset + OPTIONAL_HEADER_OFFSET_FROM_PE;
  if (optionalHeaderSize < MINIMUM_OPTIONAL_HEADER_SIZE || optionalHeaderOffset > binary.length - optionalHeaderSize) {
    throw new Error(`${label} has a truncated PE optional header`);
  }

  const magic = binary.readUInt16LE(optionalHeaderOffset);
  if (magic !== PE32_MAGIC && magic !== PE32_PLUS_MAGIC) {
    throw new Error(`${label} has an unsupported PE optional header`);
  }
  return binary.readUInt16LE(optionalHeaderOffset + SUBSYSTEM_OFFSET_FROM_OPTIONAL_HEADER);
};

export const assertWindowsGuiSubsystem = (binaryPath) => {
  const subsystem = parsePeSubsystem(fs.readFileSync(binaryPath), binaryPath);
  if (subsystem !== WINDOWS_GUI_SUBSYSTEM) {
    throw new Error(`Bundled OpenCode must use the Windows GUI subsystem (${WINDOWS_GUI_SUBSYSTEM}), got ${subsystem}: ${binaryPath}`);
  }
};
