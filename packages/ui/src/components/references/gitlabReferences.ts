/**
 * GitLab issues and merge requests in the picker's item shape.
 *
 * The picker lists one project's issues and change requests whichever host it
 * lives on. GitLab has no search document like GitHub's, so its pages come
 * from the provider-neutral list reads (page-numbered, open items) and are
 * mapped onto the rows and preview GitHub items use.
 */

import type {
    ChangeRequest,
    ChangeRequestContext,
    ChangeRequestVerdict,
    GitHubIssueReference,
    GitHubPullReference,
    GitHubReference,
    GitHubReferenceComment,
    GitHubReferenceDetail,
    GitHubReferenceKind,
    RepositoryReferenceFilter,
    Issue,
    IssueComment,
    Project,
    SourceControlAPI,
    SourceControlReadContext,
    SourceControlUser,
} from '@/lib/api/types';

import type { ListPage } from './referenceCache';

type GitLabReads = Pick<SourceControlAPI, 'issuesList' | 'changeRequestsList' | 'issueComments' | 'changeRequestContext'>;

const BODY_LIMIT = 20_000;

const author = (user: SourceControlUser | null | undefined) => (
    user ? { login: user.username, avatarUrl: user.avatarUrl } : null
);

const sourceRepo = (project: Project) => ({ owner: project.owner, repo: project.name, source: 'origin' });

const body = (text: string | undefined) => {
    const value = text ?? '';
    return { body: value.slice(0, BODY_LIMIT), bodyTruncated: value.length > BODY_LIMIT };
};

const toIssueReference = (issue: Issue): GitHubIssueReference => ({
    kind: 'issue',
    provider: 'gitlab',
    number: issue.number,
    title: issue.title,
    url: issue.url,
    ...body(issue.body),
    createdAt: issue.createdAt ?? null,
    updatedAt: issue.updatedAt ?? null,
    author: author(issue.author),
    labels: (issue.labels ?? []).map((label) => ({ name: label.name, color: label.color })),
    commentCount: 0,
    sourceRepo: sourceRepo(issue.project),
    projectId: issue.project.id,
    // GitLab does not say why an issue was closed; closed reads as done.
    state: issue.state === 'open' ? 'open' : 'completed',
});

const toPullReference = (changeRequest: ChangeRequest): GitHubPullReference => ({
    kind: 'pull',
    provider: 'gitlab',
    number: changeRequest.number,
    title: changeRequest.title,
    url: changeRequest.url,
    ...body(changeRequest.body),
    createdAt: changeRequest.createdAt ?? null,
    updatedAt: changeRequest.updatedAt ?? null,
    author: author(changeRequest.author),
    labels: [],
    commentCount: 0,
    sourceRepo: sourceRepo(changeRequest.project),
    projectId: changeRequest.project.id,
    state: changeRequest.state,
    draft: changeRequest.draft,
    head: changeRequest.head,
    base: changeRequest.base,
    headSha: changeRequest.headSha ?? '',
    headRepo: changeRequest.headProject
        ? { owner: changeRequest.headProject.owner, repo: changeRequest.headProject.name, url: changeRequest.headProject.url }
        : null,
});

/** One page of a GitLab project's issues or merge requests, filtered like GitHub's; the cursor is the next page number. */
export const fetchGitLabReferencePage = async (
    reads: GitLabReads,
    context: SourceControlReadContext,
    kind: GitHubReferenceKind,
    filter: RepositoryReferenceFilter,
    text: string,
    cursor: string | null,
): Promise<ListPage<GitHubReference>> => {
    const page = cursor ? Number(cursor) : 1;
    // An empty query is not sent.
    const options = { page, state: filter.state, people: filter.people, query: text };
    const result = kind === 'issue'
        ? await reads.issuesList(context, options).then((answer) => ({ ...answer, items: answer.items.map(toIssueReference) }))
        : await reads.changeRequestsList(context, options).then((answer) => ({ ...answer, items: answer.items.map(toPullReference) }));
    return { kind: 'page', items: result.items, cursor: result.hasMore ? String(page + 1) : null, hasMore: result.hasMore };
};

const toComment = (comment: IssueComment & { path?: string; line?: number | null }): GitHubReferenceComment => ({
    author: author(comment.author),
    body: comment.body,
    createdAt: comment.createdAt ?? null,
    url: comment.url,
    path: comment.path ?? null,
    line: comment.line ?? null,
    review: null,
});

const byCreation = (left: GitHubReferenceComment, right: GitHubReferenceComment) => (
    (left.createdAt ?? '').localeCompare(right.createdAt ?? '')
);

const pullDetail = (context: ChangeRequestContext): GitHubReferenceDetail['pull'] => {
    const commits = (context.commits ?? []).map((commit) => ({
        sha: commit.sha,
        headline: commit.headline,
        author: null,
        authorName: commit.authorName,
        committedAt: commit.committedAt,
        url: commit.url,
    }));
    return {
        reviewDecision: null,
        additions: context.files.reduce((sum, file) => sum + (file.additions ?? 0), 0),
        deletions: context.files.reduce((sum, file) => sum + (file.deletions ?? 0), 0),
        changedFiles: context.files.length,
        checks: context.changeRequest?.state === 'open' ? context.ci?.summary ?? null : null,
        commits,
        commitTotal: context.commitsComplete === false ? null : commits.length,
    };
};

/** A reviewer's approval or change request, placed among the comments like GitHub's. */
const toVerdict = (verdict: ChangeRequestVerdict): GitHubReferenceComment => ({
    author: author(verdict.author),
    body: '',
    createdAt: verdict.createdAt,
    url: verdict.url,
    path: null,
    line: null,
    review: verdict.state,
});

/** Comments, and a merge request's size and pipeline, for the previewed GitLab item. */
export const fetchGitLabReferenceDetail = async (
    reads: GitLabReads,
    context: SourceControlReadContext,
    reference: GitHubReference,
): Promise<GitHubReferenceDetail> => {
    const project = { owner: reference.sourceRepo.owner, name: reference.sourceRepo.repo };
    if (reference.kind === 'issue') {
        const comments = (await reads.issueComments(context, reference.number, project)).map(toComment).sort(byCreation);
        return { number: reference.number, comments: comments.slice(-50), commentTotal: comments.length, pull: null };
    }
    // The size comes from the changed files, which GitLab only lists with their diffs.
    const changeRequestContext = await reads.changeRequestContext(context, reference.number, { project, includeDiff: true, includeTimeline: true });
    const comments = [
        ...[...changeRequestContext.issueComments, ...changeRequestContext.reviewComments].map(toComment),
        ...(changeRequestContext.verdicts ?? []).map(toVerdict),
    ].sort(byCreation);
    return {
        number: reference.number,
        comments: comments.slice(-50),
        commentTotal: changeRequestContext.issueComments.length,
        pull: pullDetail(changeRequestContext),
    };
};
