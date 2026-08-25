import React from 'react';
import { useShallow } from 'zustand/react/shallow';

import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import {
  useEffectiveGitDirectory,
  useGitStore,
  useIsGitRepo,
  useNestedRepoSelection,
  useNestedRepos,
} from '@/stores/useGitStore';

type UseNestedGitDirectoryOptions = {
  /** False defers all probing/discovery work while the surface is hidden. */
  enabled?: boolean;
};

/**
 * Resolves the repository a git surface operates on when the project root may
 * not itself be a git repository. Owns the full resolution flow: probing the
 * root, discovering nested repositories, auto-selecting the first one, and
 * dropping a selection whose repository disappeared.
 *
 * Consumers still fetch their own git data for the returned `gitDirectory`;
 * this hook only owns who that directory is.
 */
export const useNestedGitDirectory = (
  root: string | null,
  options: UseNestedGitDirectoryOptions = {},
) => {
  const { enabled = true } = options;
  const { git } = useRuntimeAPIs();

  const rootIsGitRepo = useIsGitRepo(root);
  const gitDirectory = useEffectiveGitDirectory(root);
  const nestedRepos = useNestedRepos(root);
  const nestedRepoSelection = useNestedRepoSelection(root);

  // Probe of the resolved repository, used to detect a stale selection. Null
  // when there is nothing selected to probe.
  const selectedIsGitRepo = useIsGitRepo(
    gitDirectory && gitDirectory !== root ? gitDirectory : null,
  );

  const { ensureStatus, ensureNestedRepos, selectNestedRepo, clearNestedRepoSelection } = useGitStore(
    useShallow((state) => ({
      ensureStatus: state.ensureStatus,
      ensureNestedRepos: state.ensureNestedRepos,
      selectNestedRepo: state.selectNestedRepo,
      clearNestedRepoSelection: state.clearNestedRepoSelection,
    })),
  );

  // Probe the root itself so nested-repo resolution never depends on some
  // other surface (e.g. the sidebar badge) having probed it first.
  React.useEffect(() => {
    if (!enabled || !root) return;
    if (rootIsGitRepo !== null) return;
    void ensureStatus(root, git);
  }, [enabled, ensureStatus, git, root, rootIsGitRepo]);

  // Discover nested repositories once the root probe confirms it is not one.
  React.useEffect(() => {
    if (!enabled || !root) return;
    if (rootIsGitRepo !== false) return;
    void ensureNestedRepos(root);
  }, [enabled, ensureNestedRepos, root, rootIsGitRepo]);

  // Auto-select the first nested repository so the surface opens straight
  // into repository data; a picker (where rendered) switches between them.
  React.useEffect(() => {
    if (!enabled || !root) return;
    if (rootIsGitRepo !== false) return;
    if (!nestedRepos || nestedRepos.length === 0) return;
    if (nestedRepoSelection) return;
    selectNestedRepo(root, nestedRepos[0]);
  }, [enabled, nestedRepos, nestedRepoSelection, root, rootIsGitRepo, selectNestedRepo]);

  // A selected repository that is no longer a git repository is stale: drop
  // the selection and re-scan so resolution reflects the current tree.
  React.useEffect(() => {
    if (!enabled || !root || !nestedRepoSelection) return;
    if (!gitDirectory || gitDirectory === root) return;
    if (selectedIsGitRepo !== false) return;
    clearNestedRepoSelection(root);
    void ensureNestedRepos(root, { force: true });
  }, [
    clearNestedRepoSelection,
    enabled,
    ensureNestedRepos,
    gitDirectory,
    nestedRepoSelection,
    root,
    selectedIsGitRepo,
  ]);

  return { rootIsGitRepo, gitDirectory, nestedRepos, nestedRepoSelection };
};
