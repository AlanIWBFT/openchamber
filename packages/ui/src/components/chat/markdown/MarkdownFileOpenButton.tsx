import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import { activateMarkdownFile, useNativeMarkdownFiles, useOpenMarkdownFile } from './markdownFileReferences';
import type { FileReferenceSource } from './MarkdownPresentationContext';
import { MarkdownMediaLinkContext } from './markdown-media-context';

export function MarkdownFileOpenButton({ raw, path, inputKind = 'path' }: { raw: string; path: string; inputKind?: FileReferenceSource }) {
  const native = useNativeMarkdownFiles();
  const insideLink = React.useContext(MarkdownMediaLinkContext);
  const open = useOpenMarkdownFile();
  const { t } = useI18n();
  if (!native || insideLink) return null;
  const label = t('sidebarFilesTree.menu.openInDefaultApp');
  return (
    <Button
      variant="ghost"
      size="xs"
      className="ms-1 align-middle"
      data-export-ignore="true"
      data-message-image-export-exclude="true"
      data-openchamber-file-open={path}
      title={label}
      aria-label={label}
      onClick={(event) => activateMarkdownFile(event, () => { void open(raw, path, true, inputKind); })}
    >
      <Icon name="external-link" className="size-3.5" />
    </Button>
  );
}
