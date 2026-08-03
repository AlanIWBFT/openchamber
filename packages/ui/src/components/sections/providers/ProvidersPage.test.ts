import { describe, expect, test } from 'bun:test';
import { shouldLoadAvailableProviders, shouldLoadProviderAuthMethods } from './providerAvailability';

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
