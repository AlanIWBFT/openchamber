import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { Input } from '@/components/ui/input';
import { useOptionalThemeSystem } from '@/contexts/useThemeSystem';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';

/** OpenCode v2 stores an agent colour only as six-digit hex. */
const AGENT_HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

export const isAgentHexColor = (value: string): boolean => AGENT_HEX_COLOR.test(value);

/**
 * Colour picker for an agent's `color` config. The swatches are the current
 * theme's accent colours resolved to hex, since the config cannot hold theme
 * names; the hex field and the native picker take any other colour. An empty
 * value means automatic: OpenChamber picks one from the theme.
 */
export const AgentColorField: React.FC<{
  value: string;
  onChange: (value: string) => void;
}> = ({ value, onChange }) => {
  const { t } = useI18n();
  // Without a theme (isolated renders) only automatic and custom remain.
  const currentTheme = useOptionalThemeSystem()?.currentTheme ?? null;
  const [draft, setDraft] = React.useState(value);
  React.useEffect(() => setDraft(value), [value]);

  const swatches = React.useMemo(() => {
    if (!currentTheme) return [];
    const { syntax, status } = currentTheme.colors;
    const candidates = [
      syntax.base.keyword, syntax.base.type, syntax.base.function, syntax.base.number,
      syntax.base.string, syntax.base.operator, status.success, status.warning, status.error, status.info,
    ];
    // Themes may alias two roles to one colour or use non-hex values.
    return [...new Set(candidates.map((color) => color.trim().toLowerCase()))].filter(isAgentHexColor);
  }, [currentTheme]);

  const selected = value.toLowerCase();
  const draftInvalid = draft.trim() !== '' && !isAgentHexColor(draft.trim());
  const commitDraft = () => {
    const next = draft.trim();
    if (next === '' || isAgentHexColor(next)) onChange(next.toLowerCase());
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => onChange('')}
          aria-pressed={selected === ''}
          className={cn(
            'flex h-7 w-7 items-center justify-center rounded-md border transition-colors',
            selected === ''
              ? 'border-2 border-foreground bg-interactive-selection'
              : 'border-border/40 hover:border-border hover:bg-[var(--surface-muted)]',
          )}
          title={t('settings.agents.page.field.colorAutomatic')}
          aria-label={t('settings.agents.page.field.colorAutomatic')}
        >
          <Icon name="close" className="h-4 w-4 text-muted-foreground" />
        </button>
        {swatches.map((color) => (
          <button
            key={color}
            type="button"
            onClick={() => onChange(color)}
            aria-pressed={selected === color}
            className={cn(
              'h-7 w-7 rounded-md border transition-colors',
              selected === color
                ? 'border-2 border-foreground ring-1 ring-interactive-selection'
                : 'border-transparent hover:border-border/70',
            )}
            style={{ backgroundColor: color }}
            title={color}
            aria-label={t('settings.agents.page.field.colorSwatchAria', { color })}
          />
        ))}
      </div>
      <div className="flex items-center gap-2">
        <input
          type="color"
          value={isAgentHexColor(value) ? value : '#808080'}
          onChange={(event) => onChange(event.target.value.toLowerCase())}
          className="h-8 w-9 cursor-pointer rounded-md border border-border bg-transparent p-1"
          aria-label={t('settings.agents.page.field.colorCustomAria')}
        />
        <Input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commitDraft}
          onKeyDown={(event) => {
            if (event.key === 'Enter') commitDraft();
          }}
          placeholder="#RRGGBB"
          aria-invalid={draftInvalid}
          aria-label={t('settings.agents.page.field.colorHexAria')}
          className="h-8 w-28 rounded-md px-3 font-mono"
        />
      </div>
    </div>
  );
};
