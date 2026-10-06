/**
 * The issues and pull requests board: a full page over the chat area that
 * lists a project's repository items (GitHub or GitLab, whichever hosts it)
 * or Linear issues, previews the highlighted one and acts on it.
 *
 * The board keeps its own project. It opens on the one it was left on and
 * switching it never changes the project the rest of the app shows; only an
 * action that opens something in a project (a session, its changes) moves the
 * app there.
 */

import * as React from 'react';

import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { SortableTabsStrip } from '@/components/ui/sortable-tabs-strip';
import { NewWorktreeDialog } from '@/components/session/NewWorktreeDialog';
import { ReferenceBrowserList, ReferenceBrowserSearch } from '@/components/references/ReferenceBrowser';
import { IDLE_PULL_STATUS, useReferenceBrowser } from '@/components/references/useReferenceBrowser';
import { ReferencePreview } from '@/components/references/ReferencePreview';
import type { ReferencePickerSelection } from '@/components/references/referencePickerItems';
import { useGitHubReadContext, useRepositoryHostProvider } from '@/components/references/referenceSources';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import type { GitHubReferenceKind, LinearMappingResult, ProjectEntry, SourceControlReadContext } from '@/lib/api/types';
import { useI18n } from '@/lib/i18n';
import { resolveLinearMappedProjectPath } from '@/lib/linearProjectMapping';
import { normalizeProjectPath, resolveProjectForSessionDirectory } from '@/lib/projectResolution';
import { useLinearAuthStore } from '@/stores/useLinearAuthStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useSourceBoardChoice, useSourceBoardStore, type SourceBoardTab } from '@/stores/useSourceBoardStore';
import { useUIStore } from '@/stores/useUIStore';
import { useSessionUIStore } from '@/sync/session-ui-store';

import { SourceBoardActions, SourceBoardPullLinks, type SourceBoardProject } from './SourceBoardActions';
import { SourceBoardLinearStatus } from './SourceBoardLinearStatus';
import { SourceBoardProjectPicker, SourceBoardTeamPicker } from './SourceBoardPickers';

const openIntegrationsSettings = () => {
    const ui = useUIStore.getState();
    ui.setSettingsPage('integrations');
    ui.setSettingsDialogOpen(true);
};

/** Linear's teams and which project each one works in, read once per open and workspace. */
function useLinearMapping(enabled: boolean, workspaceId: string): LinearMappingResult | null {
    const { linear } = useRuntimeAPIs();
    const [loaded, setLoaded] = React.useState<{ workspaceId: string; mapping: LinearMappingResult } | null>(null);
    React.useEffect(() => {
        if (!enabled || !linear?.mappingGet) return;
        let cancelled = false;
        void linear.mappingGet()
            .then((mapping) => { if (!cancelled) setLoaded({ workspaceId, mapping }); })
            .catch(() => undefined);
        return () => { cancelled = true; };
    }, [enabled, linear, workspaceId]);
    return loaded && loaded.workspaceId === workspaceId ? loaded.mapping : null;
}

export const SourceBoardView: React.FC = () => {
    const open = useUIStore((state) => state.isSourceBoardOpen);
    if (!open) return null;
    return (
        <div className="absolute inset-0 z-10 flex flex-col bg-background">
            <SourceBoard />
        </div>
    );
};

/** What the board lists: the repository's issues or change requests, or Linear. */
type SourceBoardKind = GitHubReferenceKind | 'linear';

const SourceBoard: React.FC = () => {
    const { t } = useI18n();
    const { linear } = useRuntimeAPIs();
    const projects = useProjectsStore((state) => state.projects);
    const activeProjectId = useProjectsStore((state) => state.activeProjectId);
    const choice = useSourceBoardChoice();
    const updateChoice = useSourceBoardStore((state) => state.update);
    // The repository tab to land on when switching back from Linear.
    const [repositoryKind, setRepositoryKind] = React.useState<GitHubReferenceKind | undefined>(undefined);

    // The remembered project while it still exists, else the app's own.
    const project = projects.find((entry) => entry.id === choice.projectId)
        ?? projects.find((entry) => entry.id === activeProjectId)
        ?? projects[0]
        ?? null;
    const directory = project ? normalizeProjectPath(project.path) : null;
    const hostProvider = useRepositoryHostProvider(directory);
    const hasRepository = hostProvider === 'github' || hostProvider === 'gitlab';
    const hasLinear = Boolean(linear);
    const linearConnected = useLinearAuthStore((state) => state.status?.connected === true);
    const tab: SourceBoardTab | null = choice.tab === 'linear' && hasLinear
        ? 'linear'
        : hasRepository ? 'repository' : hasLinear ? 'linear' : null;

    const linearWorkspaceId = useLinearAuthStore((state) => state.status?.organization?.id ?? '');
    const mapping = useLinearMapping(tab === 'linear' && linearConnected, linearWorkspaceId);
    const teams = mapping?.teams ?? [];
    const linearTeamId = choice.linearTeamId && teams.some((team) => team.id === choice.linearTeamId) ? choice.linearTeamId : null;

    const projectPicker = project ? (
        <SourceBoardProjectPicker
            projects={projects}
            selected={project}
            onSelect={(projectId) => updateChoice({ projectId, tab: 'repository' })}
            ariaLabel={t('sourceBoard.project.label')}
            size="toolbar"
        />
    ) : null;
    // On Linear the board lists a team, not a project.
    const scopePicker = tab === 'linear' ? (
        <SourceBoardTeamPicker
            teams={teams}
            selectedTeamId={linearTeamId}
            onSelectTeam={(teamId) => updateChoice({ linearTeamId: teamId })}
            onWorkspaceSwitched={() => updateChoice({ linearTeamId: null })}
        />
    ) : projectPicker;

    const selectKind = (kind: SourceBoardKind) => {
        if (kind === 'linear') {
            updateChoice({ tab: 'linear' });
            return;
        }
        setRepositoryKind(kind);
        updateChoice({ tab: 'repository' });
    };

    if (!tab) {
        return (
            <>
                <div className="flex h-12 shrink-0 items-center border-b border-border/60 px-2">{projectPicker}</div>
                <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center typography-meta text-muted-foreground">
                    <span>{t(projects.length === 0 ? 'sourceBoard.empty.noProjects' : 'sourceBoard.empty.noSource')}</span>
                    {projects.length > 0 ? (
                        <Button size="sm" variant="outline" onClick={openIntegrationsSettings}>{t('references.picker.actions.openSettings')}</Button>
                    ) : null}
                </div>
            </>
        );
    }

    return (
        // Remounted per source and project: a new list starts with an empty search.
        <SourceBoardBody
            key={`${tab}:${tab === 'repository' ? directory : linearTeamId ?? ''}`}
            tab={tab}
            project={project}
            directory={directory}
            linearTeamId={linearTeamId}
            mapping={mapping}
            projects={projects}
            scopePicker={scopePicker}
            kinds={{ repository: hasRepository ? (hostProvider === 'gitlab' ? 'gitlab' : 'github') : null, linear: hasLinear }}
            initialRepositoryKind={repositoryKind}
            onSelectKind={selectKind}
        />
    );
};

const SourceBoardBody: React.FC<{
    tab: SourceBoardTab;
    project: ProjectEntry | null;
    directory: string | null;
    linearTeamId: string | null;
    mapping: LinearMappingResult | null;
    projects: ProjectEntry[];
    scopePicker: React.ReactNode;
    /** The tabs this project offers: its repository host's, and Linear's. */
    kinds: { repository: 'github' | 'gitlab' | null; linear: boolean };
    initialRepositoryKind?: GitHubReferenceKind;
    onSelectKind: (kind: SourceBoardKind) => void;
}> = ({ tab, project, directory, linearTeamId, mapping, projects, scopePicker, kinds, initialRepositoryKind, onSelectKind }) => {
    const { t } = useI18n();
    const source = tab === 'linear' ? 'linear' : 'github';
    const browser = useReferenceBrowser({
        source,
        directory: tab === 'linear' ? null : directory,
        isMobile: false,
        linearTeamId,
        initialGitHubKind: initialRepositoryKind,
    });
    const { previewItem } = browser;
    // A Linear issue another surface asked to show: searched for, then forgotten.
    const linearFocus = useSourceBoardStore((state) => (tab === 'linear' ? state.linearFocus : null));
    const { setQuery } = browser;
    React.useEffect(() => {
        if (!linearFocus) return;
        setQuery(linearFocus);
        useSourceBoardStore.getState().clearLinearFocus();
    }, [linearFocus, setQuery]);
    const currentDirectory = useEffectiveDirectory();
    const worktreesByProject = useSessionUIStore((state) => state.availableWorktreesByProject);
    const [worktreeRequest, setWorktreeRequest] = React.useState<{ project: SourceBoardProject; selection: ReferencePickerSelection } | null>(null);

    // A Linear issue starts in its team's project, else the mapping's default,
    // else the project the board was last on; the user can pick another.
    const [linearProjectChoice, setLinearProjectChoice] = React.useState<{ issueId: string; projectId: string } | null>(null);
    const linearIssueId = previewItem?.source === 'linear' ? previewItem.issue.id : null;
    const linearProjectOverride = linearProjectChoice && linearProjectChoice.issueId === linearIssueId ? linearProjectChoice.projectId : null;
    const linearTeam = previewItem?.source === 'linear' ? previewItem.issue.team ?? null : null;
    const mappedPath = previewItem?.source === 'linear' ? resolveLinearMappedProjectPath(mapping, linearTeam) : null;
    const mappedProject = mappedPath ? projects.find((entry) => normalizeProjectPath(entry.path) === normalizeProjectPath(mappedPath)) ?? null : null;
    const actionProjectEntry = tab === 'linear'
        ? projects.find((entry) => entry.id === linearProjectOverride) ?? mappedProject ?? project
        : project;
    const actionPath = actionProjectEntry ? normalizeProjectPath(actionProjectEntry.path) : null;
    const actionProject: SourceBoardProject | null = actionProjectEntry && actionPath ? { id: actionProjectEntry.id, path: actionPath } : null;
    const actionContext = useGitHubReadContext(actionProject?.path ?? null);
    const context: SourceControlReadContext | null = actionContext && actionContext !== 'missing' ? actionContext : null;

    const projectOwnsDirectory = React.useCallback((candidate: string | undefined) => {
        if (!candidate || !actionProjectEntry) return false;
        return resolveProjectForSessionDirectory(projects, worktreesByProject, candidate)?.id === actionProjectEntry.id;
    }, [actionProjectEntry, projects, worktreesByProject]);

    const title = t(tab === 'linear' ? 'sourceBoard.list.linear' : browser.isGitLab ? 'sourceBoard.list.gitlab' : 'sourceBoard.list.github');

    // Where a Linear issue's session starts, changeable for that issue.
    const startIn = tab === 'linear' && actionProjectEntry ? (
        <span className="flex min-w-0 items-center gap-1 typography-meta text-muted-foreground">
            {t('sourceBoard.linear.startIn')}
            <SourceBoardProjectPicker
                projects={projects}
                selected={actionProjectEntry}
                onSelect={(projectId) => { if (linearIssueId) setLinearProjectChoice({ issueId: linearIssueId, projectId }); }}
                ariaLabel={t('sourceBoard.linear.startIn')}
                size="inline"
            />
        </span>
    ) : null;

    const actions = previewItem ? (
        <SourceBoardActions
            item={previewItem}
            project={actionProject}
            context={context}
            onStartWorktree={(target, selection) => setWorktreeRequest({ project: target, selection })}
            onChanged={browser.list.retry}
            startIn={startIn}
        />
    ) : null;

    const preview = (
        <ReferencePreview
            item={previewItem}
            pullStatus={previewItem?.source === 'github' ? browser.pullStatusOf(previewItem.reference) : IDLE_PULL_STATUS}
            linearDetail={browser.linearDetail}
            githubDetail={browser.githubDetail}
            purpose="attach"
            pinned
            includeDiff={false}
            onIncludeDiffChange={() => undefined}
            now={browser.now}
            footer={actions}
            linearStateControl={previewItem?.source === 'linear' ? <SourceBoardLinearStatus issue={previewItem.issue} onChanged={browser.list.retry} /> : undefined}
            pullLinks={previewItem?.source === 'github' && previewItem.reference.kind === 'pull' && actionProject && context ? (
                <SourceBoardPullLinks
                    pull={previewItem.reference}
                    project={actionProject}
                    context={context}
                    projectOwnsDirectory={projectOwnsDirectory}
                    currentDirectory={currentDirectory}
                />
            ) : null}
        />
    );

    const list = (
        <ReferenceBrowserList
            browser={browser}
            label={title}
            multiselectable={false}
            onOpenSettings={openIntegrationsSettings}
        />
    );
    const search = <ReferenceBrowserSearch browser={browser} onKeyDown={(event) => { browser.handleNavigationKey(event); }} />;

    const worktreeDialog = (
        <NewWorktreeDialog
            open={worktreeRequest !== null}
            onOpenChange={(next) => { if (!next) setWorktreeRequest(null); }}
            project={worktreeRequest?.project}
            initialSelection={worktreeRequest?.selection}
            onWorktreeCreated={(worktreePath) => {
                useSessionUIStore.getState().openNewSessionDraft({ directoryOverride: worktreePath, preserveDirectoryOverride: true });
            }}
        />
    );

    const kindItems = [
        ...(kinds.repository ? [
            { id: 'issue', label: t('references.picker.tab.issues'), icon: <Icon name="record-circle" className="size-3.5" /> },
            { id: 'pull', label: t(kinds.repository === 'gitlab' ? 'references.picker.tab.mergeRequests' : 'references.picker.tab.pulls'), icon: <Icon name="git-pull-request" className="size-3.5" /> },
        ] : []),
        ...(kinds.linear ? [{ id: 'linear', label: 'Linear', icon: <Icon name="linear" className="size-3.5" /> }] : []),
    ];
    const kindSwitch = (
        <div className="shrink-0">
            <SortableTabsStrip
                items={kindItems}
                activeId={tab === 'linear' ? 'linear' : browser.githubKind}
                onSelect={(id) => {
                    if (id === 'linear' || tab === 'linear') {
                        onSelectKind(id === 'pull' ? 'pull' : id === 'issue' ? 'issue' : 'linear');
                        return;
                    }
                    browser.selectGitHubKind(id === 'pull' ? 'pull' : 'issue');
                }}
                variant="active-pill"
                // Sized by its labels: `fit` shares out a parent width this row does not give it.
                layoutMode="scrollable"
                activePillButtonClassName="h-7 px-3"
            />
        </div>
    );

    // One row: what is listed (scope and kind), then how it is narrowed.
    // The scope trigger's icon sits 16 px in, on the line of the rows' icons.
    return (
        <>
            <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border/60 px-2 py-2.5">
                {scopePicker}
                {kindSwitch}
                {search}
            </div>
            <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
                <ScrollableOverlay outerClassName="min-h-0 border-r border-border/60" disableHorizontal>
                    {list}
                </ScrollableOverlay>
                <div className="min-h-0">{preview}</div>
            </div>
            {worktreeDialog}
        </>
    );
};
