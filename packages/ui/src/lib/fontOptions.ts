import { z } from 'zod';

export type UiFontOption = 'inter' | 'fixel' | 'geist-sans' | 'atkinson-hyperlegible' | 'source-sans-3' | 'roboto' | 'noto-sans' | 'dm-sans' | 'manrope' | 'system';

type BuiltinMonoFontOption = 'jetbrains-mono' | 'fira-code' | 'geist-mono' | 'commit-mono' | 'source-code-pro' | 'cascadia-code' | 'roboto-mono' | 'iosevka' | 'system-mono';
export type MonoFontOption = z.infer<typeof monoFontSchema>;

export interface LocalMonoFont {
    family: string;
    label: string;
}

interface FontFaceSourceBase {
    family: string;
    weights: number[];
}

interface FontsourceFaceSource extends FontFaceSourceBase {
    packageName: string;
    filePrefix: string;
}

interface DirectFontFaceSource extends FontFaceSourceBase {
    urls: Record<number, string>;
}

export type FontFaceSource = FontsourceFaceSource | DirectFontFaceSource;

export interface FontOptionDefinition<T extends string> {
    id: T;
    label: string;
    description: string;
    stack: string;
    notes?: string;
    source?: FontFaceSource;
}

export const UI_FONT_OPTIONS: FontOptionDefinition<UiFontOption>[] = [
    {
        id: 'inter',
        label: 'Inter',
        description: 'Modern UI sans with excellent readability at small sizes.',
        stack: '"Inter", "SF Pro Text", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        source: { family: 'Inter', packageName: '@fontsource/inter', filePrefix: 'inter', weights: [400, 500, 600] }
    },
    {
        id: 'fixel',
        label: 'Fixel Text',
        description: 'Humanist geometric sans-serif with full Ukrainian support.',
        stack: '"Fixel Text", "SF Pro Text", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        source: {
            family: 'Fixel Text',
            weights: [400, 500, 600],
            urls: {
                400: 'https://cdn.jsdelivr.net/gh/MacPaw/Fixel@f6ee910e98add47e830db87f1a754130506c11a2/fonts/webfonts/FixelText-Regular.woff2',
                500: 'https://cdn.jsdelivr.net/gh/MacPaw/Fixel@f6ee910e98add47e830db87f1a754130506c11a2/fonts/webfonts/FixelText-Medium.woff2',
                600: 'https://cdn.jsdelivr.net/gh/MacPaw/Fixel@f6ee910e98add47e830db87f1a754130506c11a2/fonts/webfonts/FixelText-SemiBold.woff2'
            }
        }
    },
    {
        id: 'geist-sans',
        label: 'Geist Sans',
        description: 'Crisp sans-serif with a technical interface feel.',
        stack: '"Geist Sans", "SF Pro Text", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        source: { family: 'Geist Sans', packageName: '@fontsource/geist-sans', filePrefix: 'geist-sans', weights: [400, 500, 600] }
    },
    {
        id: 'atkinson-hyperlegible',
        label: 'Atkinson Hyperlegible',
        description: 'Accessibility-focused sans-serif optimized for character distinction.',
        stack: '"Atkinson Hyperlegible", "SF Pro Text", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        source: { family: 'Atkinson Hyperlegible', packageName: '@fontsource/atkinson-hyperlegible', filePrefix: 'atkinson-hyperlegible', weights: [400, 700] }
    },
    {
        id: 'source-sans-3',
        label: 'Source Sans 3',
        description: 'Adobe sans-serif tuned for clean, readable interfaces.',
        stack: '"Source Sans 3", "SF Pro Text", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        source: { family: 'Source Sans 3', packageName: '@fontsource/source-sans-3', filePrefix: 'source-sans-3', weights: [400, 500, 600] }
    },
    {
        id: 'roboto',
        label: 'Roboto',
        description: 'Familiar Material-style sans-serif with broad UI usage.',
        stack: '"Roboto", "SF Pro Text", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        source: { family: 'Roboto', packageName: '@fontsource/roboto', filePrefix: 'roboto', weights: [400, 500, 600] }
    },
    {
        id: 'noto-sans',
        label: 'Noto Sans',
        description: 'Readable sans-serif with strong international coverage.',
        stack: '"Noto Sans", "SF Pro Text", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        source: { family: 'Noto Sans', packageName: '@fontsource/noto-sans', filePrefix: 'noto-sans', weights: [400, 500, 600] }
    },
    {
        id: 'dm-sans',
        label: 'DM Sans',
        description: 'Modern product UI sans-serif with friendly proportions.',
        stack: '"DM Sans", "SF Pro Text", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        source: { family: 'DM Sans', packageName: '@fontsource/dm-sans', filePrefix: 'dm-sans', weights: [400, 500, 600] }
    },
    {
        id: 'manrope',
        label: 'Manrope',
        description: 'Polished geometric sans-serif for modern app interfaces.',
        stack: '"Manrope", "SF Pro Text", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        source: { family: 'Manrope', packageName: '@fontsource/manrope', filePrefix: 'manrope', weights: [400, 500, 600] }
    },
    {
        id: 'system',
        label: 'System',
        description: 'Native operating system interface font.',
        stack: '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif'
    }
];

const CODE_FONT_OPTIONS: FontOptionDefinition<BuiltinMonoFontOption>[] = [
    {
        id: 'jetbrains-mono',
        label: 'JetBrains Mono',
        description: 'Developer-focused monospace with strong punctuation clarity.',
        stack: '"JetBrains Mono", "SFMono-Regular", "Menlo", monospace',
        source: { family: 'JetBrains Mono', packageName: '@fontsource/jetbrains-mono', filePrefix: 'jetbrains-mono', weights: [400, 500, 600] }
    },
    {
        id: 'fira-code',
        label: 'Fira Code',
        description: 'Readable coding font with ligature support.',
        stack: '"Fira Code", "SFMono-Regular", "Menlo", monospace',
        source: { family: 'Fira Code', packageName: '@fontsource/fira-code', filePrefix: 'fira-code', weights: [400, 500, 600] }
    },
    {
        id: 'geist-mono',
        label: 'Geist Mono',
        description: 'Sharp monospace pair for Geist Sans.',
        stack: '"Geist Mono", "SFMono-Regular", "Menlo", monospace',
        source: { family: 'Geist Mono', packageName: '@fontsource/geist-mono', filePrefix: 'geist-mono', weights: [400, 500, 600] }
    },
    {
        id: 'commit-mono',
        label: 'Commit Mono',
        description: 'Code-oriented monospace with polished editor ergonomics.',
        stack: '"Commit Mono", "SFMono-Regular", "Menlo", monospace',
        source: { family: 'Commit Mono', packageName: '@fontsource/commit-mono', filePrefix: 'commit-mono', weights: [400, 500, 600] }
    },
    {
        id: 'source-code-pro',
        label: 'Source Code Pro',
        description: 'Adobe monospace designed for source code readability.',
        stack: '"Source Code Pro", "SFMono-Regular", "Menlo", monospace',
        source: { family: 'Source Code Pro', packageName: '@fontsource/source-code-pro', filePrefix: 'source-code-pro', weights: [400, 500, 600] }
    },
    {
        id: 'cascadia-code',
        label: 'Cascadia Code',
        description: 'Microsoft coding font popular in terminals and editors.',
        stack: '"Cascadia Code", "SFMono-Regular", "Menlo", monospace',
        source: { family: 'Cascadia Code', packageName: '@fontsource/cascadia-code', filePrefix: 'cascadia-code', weights: [400, 500, 600] }
    },
    {
        id: 'roboto-mono',
        label: 'Roboto Mono',
        description: 'Neutral monospace companion to Roboto.',
        stack: '"Roboto Mono", "SFMono-Regular", "Menlo", monospace',
        source: { family: 'Roboto Mono', packageName: '@fontsource/roboto-mono', filePrefix: 'roboto-mono', weights: [400, 500, 600] }
    },
    {
        id: 'iosevka',
        label: 'Iosevka',
        description: 'Compact monospace for dense code and terminal layouts.',
        stack: '"Iosevka", "SFMono-Regular", "Menlo", monospace',
        source: { family: 'Iosevka', packageName: '@fontsource/iosevka', filePrefix: 'iosevka', weights: [400, 500, 600] }
    },
    {
        id: 'system-mono',
        label: 'System Mono',
        description: 'Native operating system monospace font.',
        // Android registers its system mono face under this named alias, not its font-file family name.
        // A named family leaves missing CJK glyphs to the UI stack instead of generic monospace fallback.
        stack: '"SFMono-Regular", "Menlo", "Cascadia Mono", "Consolas", "Segoe UI Mono", "Liberation Mono", "DejaVu Sans Mono", "sans-serif-monospace", monospace'
    }
];

const buildFontMap = <T extends string>(options: FontOptionDefinition<T>[]) =>
    Object.fromEntries(options.map((option) => [option.id, option])) as Record<T, FontOptionDefinition<T>>;

export const UI_FONT_OPTION_MAP = buildFontMap(UI_FONT_OPTIONS);
const CODE_FONT_OPTION_MAP = buildFontMap(CODE_FONT_OPTIONS);

export const DEFAULT_UI_FONT: UiFontOption = 'system';
export const DEFAULT_MONO_FONT: BuiltinMonoFontOption = 'system-mono';

export const isUiFontOption = (value: unknown): value is UiFontOption =>
    typeof value === 'string' && value in UI_FONT_OPTION_MAP;

const isBuiltinMonoFont = (value: string): value is BuiltinMonoFontOption => Object.hasOwn(CODE_FONT_OPTION_MAP, value);

const localMonoFontSchema = z.templateLiteral(['local:', z.string()]).refine((value) => {
    const family = value.slice(6);
    return family.length > 0 && family.length <= 256 && family.trim() === family && !/[\p{Cc}]/u.test(family);
});

export const monoFontSchema = z.union([z.enum(CODE_FONT_OPTIONS.map((option) => option.id)), localMonoFontSchema]);

export const isMonoFontOption = (value: string): value is MonoFontOption => monoFontSchema.safeParse(value).success;

export const getMonoFontDefinition = (font: MonoFontOption): FontOptionDefinition<MonoFontOption> => {
    if (isBuiltinMonoFont(font)) return CODE_FONT_OPTION_MAP[font];
    if (!isMonoFontOption(font)) return CODE_FONT_OPTION_MAP[DEFAULT_MONO_FONT];
    const family = font.slice(6);
    // Escape commas as well: terminal canvas normalization splits the family list on commas.
    const quoted = `"${family.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll(',', '\\2c ')}"`;
    return { id: font, label: family, description: '', stack: quoted };
};

export const resolveMonoFontStack = (font: MonoFontOption, uiFont: UiFontOption): string => {
    const definition = getMonoFontDefinition(font);
    const systemStack = CODE_FONT_OPTION_MAP[DEFAULT_MONO_FONT].stack.replace(/, monospace$/, '');
    const primary = definition.source ? `"${definition.source.family}"` : definition.stack;
    const monoStack = definition.id === DEFAULT_MONO_FONT ? systemStack : `${primary}, ${systemStack}`;
    // A generic monospace before the UI stack would consume missing CJK glyphs first.
    return `${monoStack}, ${UI_FONT_OPTION_MAP[uiFont]?.stack ?? UI_FONT_OPTION_MAP[DEFAULT_UI_FONT].stack}`;
};

export const getCodeFontOptions = (fonts: readonly LocalMonoFont[], selected: MonoFontOption): FontOptionDefinition<MonoFontOption>[] => {
    const options: FontOptionDefinition<MonoFontOption>[] = [...CODE_FONT_OPTIONS];
    const families = new Set(CODE_FONT_OPTIONS.flatMap((option) => option.source ? [option.source.family.toLowerCase()] : []));
    for (const font of [...fonts].sort((a, b) => a.label.localeCompare(b.label))) {
        const id = `local:${font.family}`;
        if (!isMonoFontOption(id) || families.has(font.family.toLowerCase())) continue;
        families.add(font.family.toLowerCase());
        options.push({ ...getMonoFontDefinition(id), label: font.label });
    }
    // Keep a saved local choice visible even before discovery or on another device.
    if (!options.some((option) => option.id === selected) && isMonoFontOption(selected)) options.push(getMonoFontDefinition(selected));
    return options;
};
