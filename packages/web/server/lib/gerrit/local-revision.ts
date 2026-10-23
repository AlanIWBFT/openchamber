import { isString } from '../shared/guards.js';
import { isMainThread } from 'node:worker_threads';
import { readBranchChangeIds, gitForRead, type TrailerReadOptions } from '../source-control/change-id.js';
import { hasSourceControlErrorCode } from '../source-control/input-guards.js';
import { runGitReadWorkerTask, throwIfGitReadCancelled } from '../git/service.js';

const COMMIT_SHA = /^[0-9a-f]{40}$/;
const CHANGE_ID = /^I[0-9a-f]{40}$/;
const BRANCH_NAME = /^(?!-)(?!.*\.\.)[^\0-\x20\x7f~^:?*[\\{}]+$/;

export interface LocalRevision {
  sha: string | null;
  changeId: string | null;
}

export type GerritGitReader = (directory: string, args: string[]) => Promise<string>;

export async function readLocalRevision(directory: string, branch: string, options: TrailerReadOptions = {}): Promise<LocalRevision> {
  const { head: tip } = await readBranchChangeIds(directory, branch, null, options);
  return {
    sha: isString(tip?.sha) && COMMIT_SHA.test(tip.sha) ? tip.sha : null,
    changeId: tip?.changeId !== null && isString(tip?.changeId) && CHANGE_ID.test(tip.changeId) ? tip.changeId : null,
  };
}

export async function readUpstreamBranch(directory: string, branch: string, primaryRemote: string, options: TrailerReadOptions = {}): Promise<string | null> {
  throwIfGitReadCancelled(options);
  if (!isString(branch) || !BRANCH_NAME.test(branch) || !isString(primaryRemote) || !primaryRemote) return null;
  if (process.platform === 'win32' && isMainThread && !options.git) return runGitReadWorkerTask('gerrit-upstream', { directory, branch, remote: primaryRemote }, options);
  const git = gitForRead(options);
  const read = (args: string[]) => git(directory, args).then((value) => value.trim()).catch((error) => {
    throwIfGitReadCancelled(options, error);
    if (hasSourceControlErrorCode(error) && error.code === 'ETIMEDOUT') throw error;
    return '';
  });
  const remote = await read(['config', '--get', `branch.${branch}.remote`]);
  if (remote !== primaryRemote) return null;
  const tracking = await read(['rev-parse', '--symbolic-full-name', `${branch}@{upstream}`]);
  const prefix = `refs/remotes/${remote}/`;
  return tracking.startsWith(prefix) ? tracking.slice(prefix.length) || null : null;
}
