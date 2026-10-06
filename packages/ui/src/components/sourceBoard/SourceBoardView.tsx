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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { NewWorktreeDialog } from '@/components/session/NewWorktreeDialog';
import { ReferenceBrowserList, ReferenceBrowserSearch, ReferenceBrowserTabs } from '@/components/references/ReferenceBrowser';
import { IDLE_PULL_STATUS, useReferenceBrowser } from '@/components/references/useReferenceBrowser';
import { ReferencePreview } from '@/components/references/ReferencePreview';
import type { ReferencePickerSelection } from '@/components/references/referencePickerItems';
import { useGitHubReadContext, useRepositoryHostProvider } from '@/components/references/referenceSources';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import type { LinearMappingResult, ProjectEntry, SourceControlReadContext } from '@/lib/api/types';
import { useI18n } from '@/lib/i18n';
import { normalizeProjectPath, resolveProjectForSessionDirectory } from '@/lib/projectResolution';
import { formatDirectoryName } from '@/lib/utils';
import { useLinearAuthStore } from '@/stores/useLinearAuthStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useSourceBoardChoice, useSourceBoardStore, type SourceBoardTab } from '@/stores/useSourceBoardStore';
import { useUIStore } from '@/stores/useUIStore';
import { useSessionUIStore } from '@/sync/session-ui-store';

import { SourceBoardActions, SourceBoardPullLinks, type SourceBoardProject } from './SourceBoardActions';

const ALL_TEAMS = '__all__';

const projectLabel = (project: ProjectEntry): string => project.label?.trim() || formatDirectoryName(project.path) || project.path;

const openIntegrationsSettings = () => {
    const ui = useUIStore.getState();
    ui.setSettingsPage('integrations');
    ui.setSettingsDialogOpen(true);
};

/** Linear's teams and which project each one works in, read once per open. */
function useLinearMapping(enabled: boolean): LinearMappingResult | null {
    const { linear } = useRuntimeAPIs();
    const [mapping, setMapping] = React.useState<LinearMappingResult | null>(null);
    React.useEffect(() => {
        if (!enabled || !linear?.mappingGet) return;
        let cancelled = false;
        void linear.mappingGet()
            .then((result) => { if (!cancelled) setMapping(result); })
            .catch(() => undefined);
        return () => { cancelled = true; };
    }, [enabled, linear]);
    return mapping;
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

const SourceBoard: React.FC = () => {
    const { t } = useI18n();
    const { linear } = useRuntimeAPIs();
    const projects = useProjectsStore((state) => state.projects);
    const activeProjectId = useProjectsStore((state) => state.activeProjectId);
    const choice = useSourceBoardChoice();
    const updateChoice = useSourceBoardStore((state) => state.update);

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

    const mapping = useLinearMapping(tab === 'linear' && linearConnected);
    const teams = mapping?.teams ?? [];
    const linearTeamId = choice.linearTeamId && teams.some((team) => team.id === choice.linearTeamId) ? choice.linearTeamId : null;

    const sourceButton = (id: SourceBoardTab, icon: 'github' | 'gitlab' | 'linear', label: string) => (
        <Button
            key={id}
            type="button"
            variant="chip"
            size="sm"
            aria-pressed={tab === id}
            onClick={() => updateChoice({ tab: id })}
        >
            <Icon name={icon} className="size-4" />
            {label}
        </Button>
    );

    const sourceSwitch = (
        <div className="flex shrink-0 items-center gap-1" role="group" aria-label={t('sourceBoard.source.label')}>
            {hasRepository ? sourceButton('repository', hostProvider === 'gitlab' ? 'gitlab' : 'github', hostProvider === 'gitlab' ? 'GitLab' : 'GitHub') : null}
            {hasLinear ? sourceButton('linear', 'linear', 'Linear') : null}
        </div>
    );

    const scopePicker = tab === 'linear' ? (
        teams.length > 0 ? (
            <Select
                value={linearTeamId ?? ALL_TEAMS}
                onValueChange={(value) => updateChoice({ linearTeamId: value === ALL_TEAMS ? null : value })}
            >
                <SelectTrigger aria-label={t('sourceBoard.team.label')} className="h-8 w-[14rem]">
                    <SelectValue>{teams.find((team) => team.id === linearTeamId)?.name ?? t('sourceBoard.team.all')}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                    <SelectItem value={ALL_TEAMS}>{t('sourceBoard.team.all')}</SelectItem>
                    {teams.map((team) => <SelectItem key={team.id} value={team.id}>{team.name}</SelectItem>)}
                </SelectContent>
            </Select>
        ) : null
    ) : project ? (
        <Select value={project.id} onValueChange={(value) => updateChoice({ projectId: value })}>
            <SelectTrigger aria-label={t('sourceBoard.project.label')} className="h-8 w-[14rem]">
                <SelectValue>{projectLabel(project)}</SelectValue>
            </SelectTrigger>
            <SelectContent>
                {projects.map((entry) => <SelectItem key={entry.id} value={entry.id}>{projectLabel(entry)}</SelectItem>)}
            </SelectContent>
        </Select>
    ) : null;

    const toolbar = (
        <div className="flex flex-wrap items-center gap-2">
            {sourceSwitch}
            {scopePicker}
        </div>
    );

    if (!tab) {
        return (
            <>
                <div className="shrink-0 border-b border-border/60 px-5 py-3">{toolbar}</div>
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
            toolbar={toolbar}
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
    toolbar: React.ReactNode;
}> = ({ tab, project, directory, linearTeamId, mapping, projects, toolbar }) => {
    const { t } = useI18n();
    const source = tab === 'linear' ? 'linear' : 'github';
    const browser = useReferenceBrowser({ source, directory: tab === 'linear' ? null : directory, isMobile: false, linearTeamId });
    const { previewItem } = browser;
    const currentDirectory = useEffectiveDirectory();
    const worktreesByProject = useSessionUIStore((state) => state.availableWorktreesByProject);
    const [worktreeRequest, setWorktreeRequest] = React.useState<{ project: SourceBoardProject; selection: ReferencePickerSelection } | null>(null);

    // A Linear issue starts in its team's project, else the mapping's default,
    // else the project the board was last on; the user can pick another.
    const [linearProjectChoice, setLinearProjectChoice] = React.useState<{ issueId: string; projectId: string } | null>(null);
    const linearIssueId = previewItem?.source === 'linear' ? previewItem.issue.id : null;
    const linearProjectOverride = linearProjectChoice && linearProjectChoice.issueId === linearIssueId ? linearProjectChoice.projectId : null;
    const linearTeam = previewItem?.source === 'linear' ? previewItem.issue.team ?? null : null;
    const mappedPath = (linearTeam && mapping?.teams?.find((team) => team.id === linearTeam.id)?.projectPath) || mapping?.defaultProjectPath || null;
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

    const linearProjectPicker = tab === 'linear' && actionProjectEntry ? (
        <label className="flex items-center gap-2 typography-meta text-muted-foreground">
            {t('sourceBoard.linear.startIn')}
            <Select
                value={actionProjectEntry.id}
                onValueChange={(projectId) => { if (linearIssueId) setLinearProjectChoice({ issueId: linearIssueId, projectId }); }}
            >
                <SelectTrigger aria-label={t('sourceBoard.linear.startIn')} className="h-7 w-[14rem]">
                    <SelectValue>{projectLabel(actionProjectEntry)}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                    {projects.map((entry) => <SelectItem key={entry.id} value={entry.id}>{projectLabel(entry)}</SelectItem>)}
                </SelectContent>
            </Select>
        </label>
    ) : null;

    const actions = previewItem ? (
        <SourceBoardActions
            item={previewItem}
            project={actionProject}
            context={context}
            onStartWorktree={(target, selection) => setWorktreeRequest({ project: target, selection })}
            onChanged={browser.list.retry}
            projectPicker={linearProjectPicker}
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

    return (
        <>
            <div className="flex shrink-0 flex-col gap-3 border-b border-border/60 px-5 pb-3 pt-4">
                {toolbar}
                <div className="flex flex-wrap items-center gap-3">
                    <ReferenceBrowserTabs browser={browser} />
                    {search}
                </div>
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
