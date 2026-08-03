export const shouldLoadAvailableProviders = (isAddMode: boolean): boolean => isAddMode;

/** Auth methods are needed when adding a provider or reconnecting an existing one. */
export const shouldLoadProviderAuthMethods = (isAddMode: boolean, showAuthPanel: boolean): boolean =>
  isAddMode || showAuthPanel;
