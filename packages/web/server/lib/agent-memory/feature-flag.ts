const TRUTHY = new Set(['1', 'true', 'yes', 'on']);

export const isAgentMemoryFeatureAvailable = () => {
  const raw = process.env.OPENCHAMBER_MEMORY_ENABLE ?? '1';
  return TRUTHY.has(raw.trim().toLowerCase());
};
