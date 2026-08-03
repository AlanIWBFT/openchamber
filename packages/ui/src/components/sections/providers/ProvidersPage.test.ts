import { describe, expect, test } from 'bun:test';
import { shouldLoadAvailableProviders, shouldLoadProviderAuthMethods } from './providerAvailability';
import { listOAuthMethods, normalizeAuthType } from './providerAuthMethods';

describe('ProvidersPage available provider loading', () => {
  test('loads available providers only in add-provider mode', () => {
    expect(shouldLoadAvailableProviders(false)).toBe(false);
    expect(shouldLoadAvailableProviders(true)).toBe(true);
  });
});

describe('ProvidersPage auth method loading', () => {
  test('loads auth methods for add mode and reconnect panel', () => {
    expect(shouldLoadProviderAuthMethods(false, false)).toBe(false);
    expect(shouldLoadProviderAuthMethods(true, false)).toBe(true);
    expect(shouldLoadProviderAuthMethods(false, true)).toBe(true);
    expect(shouldLoadProviderAuthMethods(true, true)).toBe(true);
  });
});

describe('ProvidersPage OAuth method indexes', () => {
  test('preserves the original provider.auth() index after filtering', () => {
    const methods = listOAuthMethods([
      { type: 'api' },
      { type: 'oauth', label: 'Browser' },
    ]);
    expect(methods).toEqual([{ method: { type: 'oauth', label: 'Browser' }, methodIndex: 1 }]);
  });

  test('keeps multiple OAuth indexes relative to the full methods array', () => {
    const methods = listOAuthMethods([
      { type: 'oauth', label: 'First' },
      { type: 'api' },
      { type: 'oauth', label: 'Second' },
    ]);
    expect(methods.map((entry) => entry.methodIndex)).toEqual([0, 2]);
  });

  test('detects oauth from labels when type is missing', () => {
    expect(normalizeAuthType({ label: 'Sign in with OAuth' })).toBe('oauth');
    expect(normalizeAuthType({ name: 'API Key' })).toBe('api');
  });
});
