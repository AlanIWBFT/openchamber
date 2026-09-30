// Run after Tailwind so semantic classes and arbitrary text-[...] sizes follow
// the same device-pixel rule. Other stylesheets (for example KaTeX) keep their
// own layout metrics. The rem root remains unrounded for interface scaling.
export default function pixelFonts() {
  return {
    postcssPlugin: 'openchamber-pixel-fonts',
    OnceExit(root) {
      const file = root.source?.input.file?.replaceAll('\\', '/') ?? '';
      if (!file.endsWith('/packages/ui/src/index.css')) return;
      root.walkDecls('font-size', (declaration) => {
        const value = declaration.value.trim();
        if (!/^(?:\d|\.|var\(|calc\(|min\(|max\(|clamp\(|round\()/i.test(value)) return;
        if (value === '0' || value === '1px' || value.includes('--font-pixel-ratio')) return;
        const selectors = declaration.parent.selector?.split(',').map((selector) => selector.trim()) ?? [];
        if (selectors.some((selector) => [':root', 'html', ':host'].includes(selector))) return;
        // Match pixelFontSize: rem conversion can land just above an integer in
        // floating point. Ignore sub-0.0001-physical-pixel noise before ceiling.
        declaration.value = `calc(round(up, (${value}) * var(--font-pixel-ratio, 1) - 0.0001px, 1px) / var(--font-pixel-ratio, 1) * var(--font-pixel-align, 1) + (${value}) * (1 - var(--font-pixel-align, 1)))`;
      });
    },
  };
}
