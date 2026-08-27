import React from 'react';

import { ProjectNotesTodoPanel } from '@/components/session/project-context/ProjectNotesTodoPanel';
import { useGitStore } from '@/stores/useGitStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { formatDirectoryName } from '@/lib/utils';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { CHAT_DRAFT_PROJECT_ID } from '@/lib/chatDirectories';
import { useI18n } from '@/lib/i18n';
import { useProjectContextOwner } from '@/hooks/useProjectContextOwner';

export const ProjectContextPanel: React.FC<{
  onActionComplete?: () => void;
  onOpenPlan?: (plan: { id: string; title: string }) => void;
}> = ({ onActionComplete, onOpenPlan }) => {
  const projects = useProjectsStore((state) => state.projects);
  const homeDirectory = useDirectoryStore((state) => state.homeDirectory);
  const { t } = useI18n();
  const gitDirectories = useGitStore((state) => state.directories);
  const chatSessionDirectory = useSessionUIStore((state) => state.currentSessionDirectory);
  const projectRef = useProjectContextOwner(chatSessionDirectory);
  const isChatContext = projectRef?.id === CHAT_DRAFT_PROJECT_ID;

  const activeProject = React.useMemo(() => {
    if (isChatContext) return null;
    return projects.find((project) => project.id === projectRef?.id) ?? null;
  }, [isChatContext, projectRef?.id, projects]);

  const projectLabel = React.useMemo(() => {
    if (isChatContext) return t('sessions.sidebar.activity.chatsTitle');
    if (!activeProject) {
      return null;
    }
    return activeProject.label?.trim()
      || formatDirectoryName(activeProject.path, homeDirectory)
      || activeProject.path;
  }, [activeProject, homeDirectory, isChatContext, t]);

  const canCreateWorktree = React.useMemo(() => {
    if (!activeProject) {
      return false;
    }
    return gitDirectories.get(activeProject.path)?.isGitRepo === true;
  }, [activeProject, gitDirectories]);

  return (
    /* The panel scrolls its own tab content; a scroller here would nest. */
    <div className="h-full min-h-0 overflow-hidden bg-background">
      <ProjectNotesTodoPanel
        projectRef={projectRef}
        projectLabel={projectLabel}
        canCreateWorktree={canCreateWorktree}
        onActionComplete={onActionComplete}
        onOpenPlan={onOpenPlan}
      />
    </div>
  );
};
