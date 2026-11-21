import { OpenChamberLogo } from '@/components/ui/OpenChamberLogo';
import React from 'react';
import { isDesktopShell, requestFileAccess, startDesktopWindowDrag } from '@/lib/desktop';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Icon } from "@/components/icon/Icon";
import { loadDesktopSettings, updateDesktopSettings } from '@/lib/persistence';
import { restartDesktopApp } from '@/lib/desktop';
import { cn } from '@/lib/utils';
import { useWaitingBlink } from '@/hooks/useDurationTicker';
import { RemoteConnectionForm } from './RemoteConnectionForm';
import { desktopHostsGet, desktopHostsSet } from '@/lib/desktopHosts';
import { useI18n } from '@/lib/i18n';
import { toast } from '@/components/ui';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { useEnterprisePolicyStore } from '@/stores/useEnterprisePolicyStore';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';

const POLL_INTERVAL_MS = 2500;

type OnboardingPlatform = 'macos' | 'linux' | 'windows' | 'unknown';

type ChooserScreenProps = {
  onCliAvailable?: () => void;
  localAvailable?: boolean;
};

function WatchingDot() {
  const blink = useWaitingBlink(true);
  return <span className={cn('absolute inset-0 rounded-full', blink)} style={{ backgroundColor: 'var(--primary-base)' }} />;
}

export function ChooserScreen({ onCliAvailable, localAvailable = true }: ChooserScreenProps) {
  const { t } = useI18n();
  const [isDesktopApp, setIsDesktopApp] = React.useState(false);
  const [isApplyingPath, setIsApplyingPath] = React.useState(false);
  const [isManualChecking, setIsManualChecking] = React.useState(false);
  const [opencodeBinary, setOpencodeBinary] = React.useState('');
  const pinnedBinary = useEnterprisePolicyStore((state) => state.opencodeBinary);
  const [platform, setPlatform] = React.useState<OnboardingPlatform>('unknown');
  const [activeTab, setActiveTab] = React.useState<'local' | 'remote'>(() => localAvailable ? 'local' : 'remote');
  const [advancedOpen, setAdvancedOpen] = React.useState(true);
  const [troubleOpen, setTroubleOpen] = React.useState(false);

  React.useEffect(() => {
    setIsDesktopApp(isDesktopShell());
  }, []);

  React.useEffect(() => {
    if (typeof navigator === 'undefined') {
      setPlatform('unknown');
      return;
    }

    const ua = navigator.userAgent || '';
    if (/Windows/i.test(ua)) setPlatform('windows');
    else if (/Macintosh|Mac OS X/i.test(ua)) setPlatform('macos');
    else if (/Linux/i.test(ua)) setPlatform('linux');
    else setPlatform('unknown');
  }, []);

  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const data = await loadDesktopSettings();
        if (!data || cancelled) return;
        const value = data.opencodeBinary ?? '';
        if (value) setOpencodeBinary(value);
      } catch {
        // ignore
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleDragStart = React.useCallback(async (e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    if (target.closest('.app-region-no-drag')) return;
    if (target.closest('button, a, input, select, textarea, code, summary, details')) return;
    if (e.button !== 0) return;
    if (isDesktopApp) {
      await startDesktopWindowDrag();
    }
  }, [isDesktopApp]);

  const checkCliAvailability = React.useCallback(async (): Promise<boolean> => {
    try {
      const response = await runtimeFetch('/health');
      if (!response.ok) return false;
      const data = await response.json();
      return data.openCodeRunning === true || data.isOpenCodeReady === true;
    } catch {
      return false;
    }
  }, []);

  const persistFirstChoice = React.useCallback(async (choice: 'local' | 'remote') => {
    if (!isDesktopApp) return;

    const config = await desktopHostsGet();
    await desktopHostsSet({
      ...config,
      ...(choice === 'local' ? { defaultHostId: 'local' } : {}),
      initialHostChoiceCompleted: true,
    });
  }, [isDesktopApp]);

  const announceAvailable = React.useCallback(async () => {
    if (isDesktopApp) {
      await persistFirstChoice('local');
    }
    onCliAvailable?.();
  }, [isDesktopApp, onCliAvailable, persistFirstChoice]);

  React.useEffect(() => {
    if (!localAvailable || activeTab !== 'local') return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      if (cancelled) return;
      try {
        const available = await checkCliAvailability();
        if (cancelled) return;
        if (available) {
          await announceAvailable();
          return;
        }
      } catch {
        // ignore
      }
      if (!cancelled) {
        timer = setTimeout(tick, POLL_INTERVAL_MS);
      }
    };

    timer = setTimeout(tick, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [activeTab, checkCliAvailability, announceAvailable, localAvailable]);

  const handleManualCheck = React.useCallback(async () => {
    setIsManualChecking(true);
    try {
      const available = await checkCliAvailability();
      if (available) await announceAvailable();
    } finally {
      setIsManualChecking(false);
    }
  }, [checkCliAvailability, announceAvailable]);

  const handleBrowse = React.useCallback(async () => {
    if (typeof window === 'undefined') return;
    if (!isDesktopApp) return;

    try {
      const selected = await requestFileAccess();
      if (selected.success && selected.path && selected.path.trim().length > 0) {
        setOpencodeBinary(selected.path.trim());
      }
    } catch {
      // ignore
    }
  }, [isDesktopApp]);

  const handleApplyPath = React.useCallback(async () => {
    setIsApplyingPath(true);
    try {
      if (!(await updateDesktopSettings({ opencodeBinary: opencodeBinary.trim() })).ok) {
        toast.error(t('onboarding.localSetup.description'));
        return;
      }
      if (isDesktopApp) {
        await persistFirstChoice('local');
        await restartDesktopApp();
        return;
      }
      await runtimeFetch('/api/config/reload', { method: 'POST' });
    } finally {
      setTimeout(() => setIsApplyingPath(false), 1000);
    }
  }, [isDesktopApp, opencodeBinary, persistFirstChoice, t]);

  const binaryPlaceholder =
    platform === 'windows'
      ? 'C:\\Tools\\OpenCode\\opencode.exe'
      : platform === 'linux'
        ? '/home/you/.opencode/bin/opencode'
        : '/Users/you/.opencode/bin/opencode';

  const showLocal = localAvailable && (!isDesktopApp || activeTab === 'local');

  return (
    <ScrollableOverlay
      outerClassName="h-full bg-transparent"
      className="app-region-drag flex items-center justify-center p-8 cursor-default select-none"
      onMouseDown={handleDragStart}
      disableHorizontal
    >
      <div className="w-full max-w-md">
        <header className="flex flex-col items-center text-center">
          <OpenChamberLogo width={48} height={48} />
          <h1 className="mt-6 text-xl font-semibold tracking-tight text-foreground">
            {t('onboarding.chooser.title')}
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {t('onboarding.chooser.description')}
          </p>
        </header>

        {isDesktopApp && localAvailable && (
          <div role="tablist" className="app-region-no-drag mt-7 flex gap-1 rounded-lg border border-border p-1">
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'local'}
              className={cn(
                'flex-1 rounded-md px-3 py-1.5 text-sm transition-colors',
                activeTab === 'local'
                  ? 'bg-[var(--interactive-selection)] text-[var(--interactive-selection-foreground)]'
                  : 'text-muted-foreground hover:text-foreground'
              )}
              onClick={() => setActiveTab('local')}
            >
              {t('onboarding.chooser.tabs.localInstall')}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'remote'}
              className={cn(
                'flex-1 rounded-md px-3 py-1.5 text-sm transition-colors',
                activeTab === 'remote'
                  ? 'bg-[var(--interactive-selection)] text-[var(--interactive-selection-foreground)]'
                  : 'text-muted-foreground hover:text-foreground'
              )}
              onClick={() => setActiveTab('remote')}
            >
              {t('onboarding.chooser.tabs.connectRemote')}
            </button>
          </div>
        )}

        {isDesktopApp && activeTab === 'remote' ? (
          <div className="app-region-no-drag mt-6">
            <RemoteConnectionForm
              onBack={() => localAvailable && setActiveTab('local')}
              showBackButton={false}
              showInstancePicker={!localAvailable}
              onSwitchToLocal={localAvailable ? () => setActiveTab('local') : undefined}
            />
          </div>
        ) : null}

        {showLocal && (
          <div className="mt-6">
            <p className="text-center text-sm leading-relaxed text-muted-foreground text-balance">
              {t('onboarding.localSetup.description')}
            </p>

            <div className="app-region-no-drag mt-3 flex items-center gap-2.5 px-1" role="status" aria-live="polite">
              <span className="relative inline-flex h-2 w-2 shrink-0" aria-hidden>
                <WatchingDot />
              </span>
              <span className="min-w-0 flex-1 text-xs text-muted-foreground">
                <span className="text-foreground">{t('onboarding.localSetup.status.watching')}</span>
                {' · '}
                {t('onboarding.localSetup.status.autoContinue')}
              </span>
              <button
                type="button"
                onClick={handleManualCheck}
                disabled={isManualChecking}
                className="shrink-0 text-xs text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
              >
                {isManualChecking ? t('onboarding.localSetup.actions.checking') : t('onboarding.localSetup.actions.checkNow')}
              </button>
            </div>

            <div className="mt-6 divide-y divide-edge border-y border-edge">
              <details
                className="app-region-no-drag group"
                open={advancedOpen}
                onToggle={(e) => setAdvancedOpen(e.currentTarget.open)}
              >
                <summary className="flex cursor-pointer list-none items-center justify-between py-3 text-sm text-muted-foreground transition-colors hover:text-foreground [&::-webkit-details-marker]:hidden">
                  <span>{t('onboarding.localSetup.advanced.title')}</span>
                  <Icon name="arrow-down-s" className="h-4 w-4 transition-transform group-open:rotate-180" />
                </summary>
                <div className="space-y-2 pb-4">
                  <div className="flex gap-2">
                    <Input
                      value={pinnedBinary ?? opencodeBinary}
                      onChange={(e) => setOpencodeBinary(e.target.value)}
                      placeholder={binaryPlaceholder}
                      disabled={isApplyingPath || pinnedBinary !== null}
                      className="flex-1 font-mono text-xs"
                    />
                    {pinnedBinary === null && (
                      <>
                        <Button type="button" variant="secondary" size="sm" onClick={handleBrowse} disabled={isApplyingPath || !isDesktopApp}>
                          {t('onboarding.localSetup.actions.browse')}
                        </Button>
                        <Button type="button" size="sm" onClick={handleApplyPath} disabled={isApplyingPath || !opencodeBinary.trim()}>
                          {t('onboarding.localSetup.actions.apply')}
                        </Button>
                      </>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {t(pinnedBinary === null ? 'onboarding.localSetup.helper.saveAndReload' : 'onboarding.localSetup.helper.pinnedByAdministrator')}
                  </p>
                </div>
              </details>
              <details
                className="app-region-no-drag group"
                open={troubleOpen}
                onToggle={(e) => setTroubleOpen(e.currentTarget.open)}
              >
                <summary className="flex cursor-pointer list-none items-center justify-between py-3 text-sm text-muted-foreground transition-colors hover:text-foreground [&::-webkit-details-marker]:hidden">
                  <span>{t('onboarding.localSetup.troubleshoot.title')}</span>
                  <Icon name="arrow-down-s" className="h-4 w-4 transition-transform group-open:rotate-180" />
                </summary>
                <ul className="list-disc space-y-1.5 pb-4 ps-4 text-xs text-muted-foreground">
                  {platform === 'windows' ? (
                    <li>{t('onboarding.localSetup.windows.hintDetectionFailed')}</li>
                  ) : (
                    <>
                      <li>{t('onboarding.localSetup.hint.ensurePath')}</li>
                      <li>{t('onboarding.localSetup.hint.setEnv')}</li>
                      <li>{t('onboarding.localSetup.hint.missingRuntime')}</li>
                    </>
                  )}
                </ul>
              </details>
            </div>

          </div>
        )}
      </div>
    </ScrollableOverlay>
  );
}
