/**
 * Whether agent memory exists at all in this build.
 *
 * Memory is available by default. The environment variable remains a process-
 * level kill switch that can remove the tool, routes, session index and
 * settings row together.
 *
 * Read per call rather than captured at import, so a process started with the
 * variable set is the only thing that decides — no build step bakes it in.
 */

const TRUTHY = new Set(['1', 'true', 'yes', 'on']);

export const isAgentMemoryFeatureAvailable = () => {
  const raw = process.env.OPENCHAMBER_MEMORY_ENABLE ?? '1';
  return typeof raw === 'string' && TRUTHY.has(raw.trim().toLowerCase());
};
