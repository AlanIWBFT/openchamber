import { readEnterprisePolicy } from '../../web/server/lib/enterprise-mode.js';
import { forkRequired, readOpenCodeInfo } from '../../web/server/lib/opencode/compatibility.js';

type UpgradeCapability = {
  supported: boolean;
  manager: 'opencode' | 'external' | 'openchamber' | 'administrator' | null;
  reason: 'external' | 'unavailable' | 'policy' | null;
};

export type OpenCodeUpgradeManager = {
  getApiUrl(): string | null;
  getOpenCodeAuthHeaders(): Record<string, string>;
  getDebugInfo(): { mode: 'managed' | 'external'; cliPath: string | null };
  upgradeCli(): Promise<void>;
};

type UpgradeResult =
  | { status: 200; body: { success: true } }
  | { status: 409; body: { success: false; code: 'OPENCODE_UPGRADE_UNSUPPORTED'; error: string; upgrade: UpgradeCapability } }
  | { status: 500; body: { success: false; error: string } };

const getCapability = (manager?: OpenCodeUpgradeManager): UpgradeCapability => {
  if (!manager) return { supported: false, manager: null, reason: 'unavailable' };
  if (manager.getDebugInfo().mode !== 'managed') return { supported: false, manager: 'external', reason: 'external' };
  if (readEnterprisePolicy().opencodeBinary) return { supported: false, manager: 'administrator', reason: 'policy' };
  return { supported: false, manager: null, reason: 'unavailable' };
};

const getApiUrl = (manager?: OpenCodeUpgradeManager): string | null => {
  const apiUrl = manager?.getApiUrl();
  return apiUrl ? `${apiUrl.replace(/\/+$/, '')}/` : null;
};

export const getOpenCodeUpgradeStatus = async (manager?: OpenCodeUpgradeManager): Promise<Record<string, unknown>> => {
  const upgrade = getCapability(manager);
  const apiUrl = getApiUrl(manager);
  if (!apiUrl || !manager) return { available: false, currentVersion: null, latestVersion: null, upgrade };
  try {
    const response = await fetch(new URL('/api/info', apiUrl), { headers: { Accept: 'application/json', ...manager.getOpenCodeAuthHeaders() }, signal: AbortSignal.timeout(3000) });
    const info = await readOpenCodeInfo(response);
    return { available: false, currentVersion: info?.version ?? null, latestVersion: null, upgrade };
  } catch (error) {
    return { available: null, error: error instanceof Error ? error.message : String(error), upgrade };
  }
};

export const upgradeManagedOpenCode = async (manager?: OpenCodeUpgradeManager): Promise<UpgradeResult> => {
  const upgrade = getCapability(manager);
  return {
    status: 409,
    body: {
      success: false,
      code: 'OPENCODE_UPGRADE_UNSUPPORTED',
      error: forkRequired,
      upgrade,
    },
  };
};
