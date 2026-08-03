export type ProviderAuthMethod = {
  type?: string;
  name?: string;
  label?: string;
  description?: string;
  help?: string;
};

export const normalizeAuthType = (method: ProviderAuthMethod): string => {
  const raw = typeof method.type === 'string' ? method.type : '';
  const label = `${method.name ?? ''} ${method.label ?? ''}`.toLowerCase();
  const merged = `${raw} ${label}`.toLowerCase();
  if (merged.includes('oauth')) return 'oauth';
  if (merged.includes('api')) return 'api';
  return raw.toLowerCase();
};

/** OAuth methods with the original provider.auth() method index OpenCode expects. */
export const listOAuthMethods = (
  methods: ProviderAuthMethod[],
): Array<{ method: ProviderAuthMethod; methodIndex: number }> =>
  methods
    .map((method, methodIndex) => ({ method, methodIndex }))
    .filter(({ method }) => normalizeAuthType(method) === 'oauth');
