const QUIT_COPY = {
  en: { title: 'Closing OpenChamber', detail: 'Finishing background cleanup...' },
  fr: { title: 'Fermeture d\'OpenChamber', detail: 'Finalisation du nettoyage en arrière-plan...' },
  'zh-CN': { title: '正在退出 OpenChamber', detail: '正在完成后台清理...' },
  'zh-TW': { title: '正在結束 OpenChamber', detail: '正在完成背景清理...' },
  uk: { title: 'Завершення роботи OpenChamber', detail: 'Завершення фонового очищення...' },
  es: { title: 'Cerrando OpenChamber', detail: 'Finalizando la limpieza en segundo plano...' },
  'pt-BR': { title: 'Fechando o OpenChamber', detail: 'Finalizando a limpeza em segundo plano...' },
  ko: { title: 'OpenChamber 종료 중', detail: '백그라운드 정리를 마무리하는 중...' },
  pl: { title: 'Zamykanie OpenChamber', detail: 'Kończenie czyszczenia w tle...' },
  ja: { title: 'OpenChamber を終了しています', detail: 'バックグラウンドのクリーンアップを完了しています...' },
};

const escapeHtml = (value) => String(value)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

const safeColor = (value, fallback) => {
  const candidate = typeof value === 'string' ? value.trim() : '';
  return /^(?:#[0-9a-f]{3,8}|rgba?\([\d\s.,%]+\)|hsla?\([\d\s.,%]+\))$/i.test(candidate)
    ? candidate
    : fallback;
};

export const normalizeQuitLocale = (value) => {
  const normalized = String(value || '').toLowerCase().replace(/_/g, '-');
  if (normalized === 'zh-tw' || normalized === 'zh-hant' || normalized.startsWith('zh-hant-')) return 'zh-TW';
  if (normalized.startsWith('zh')) return 'zh-CN';
  if (normalized.startsWith('fr')) return 'fr';
  if (normalized.startsWith('uk') || normalized.startsWith('ua')) return 'uk';
  if (normalized.startsWith('es')) return 'es';
  if (normalized === 'pt' || normalized.startsWith('pt-br')) return 'pt-BR';
  if (normalized.startsWith('ko')) return 'ko';
  if (normalized.startsWith('pl')) return 'pl';
  if (normalized.startsWith('ja')) return 'ja';
  return 'en';
};

export const closeMiniChatWindows = (windows) => {
  let closed = 0;
  for (const browserWindow of windows) {
    if (!browserWindow || browserWindow.__ocMiniChat !== true || browserWindow.isDestroyed()) continue;
    try {
      browserWindow.close();
      closed += 1;
    } catch {
    }
  }
  return closed;
};

export const buildSplashLogoSvg = ({ ariaLabel = 'OpenChamber', decorative = false } = {}) => `<svg width="120" height="120" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg"${decorative ? ' aria-hidden="true"' : ` role="img" aria-label="${escapeHtml(ariaLabel)}"`}>
  <path d="M50 50 L8.432 26 L8.432 74 L50 98 Z" fill="var(--splash-face-fill)" stroke="var(--splash-stroke)" stroke-width="2" stroke-linejoin="round"/>
  <path d="M50 50 L39.608 44 L39.608 56 L50 62 Z" fill="var(--splash-cell-fill)" opacity="0.2"/>
  <path d="M39.608 44 L29.216 38 L29.216 50 L39.608 56 Z" fill="var(--splash-cell-fill)" opacity="0.45"/>
  <path d="M29.216 38 L18.824 32 L18.824 44 L29.216 50 Z" fill="var(--splash-cell-fill)" opacity="0.15"/>
  <path d="M18.824 32 L8.432 26 L8.432 38 L18.824 44 Z" fill="var(--splash-cell-fill)" opacity="0.55"/>
  <path d="M50 62 L39.608 56 L39.608 68 L50 74 Z" fill="var(--splash-cell-fill)" opacity="0.35"/>
  <path d="M39.608 56 L29.216 50 L29.216 62 L39.608 68 Z" fill="var(--splash-cell-fill)" opacity="0.1"/>
  <path d="M29.216 50 L18.824 44 L18.824 56 L29.216 62 Z" fill="var(--splash-cell-fill)" opacity="0.5"/>
  <path d="M18.824 44 L8.432 38 L8.432 50 L18.824 56 Z" fill="var(--splash-cell-fill)" opacity="0.25"/>
  <path d="M50 74 L39.608 68 L39.608 80 L50 86 Z" fill="var(--splash-cell-fill)" opacity="0.4"/>
  <path d="M39.608 68 L29.216 62 L29.216 74 L39.608 80 Z" fill="var(--splash-cell-fill)" opacity="0.3"/>
  <path d="M29.216 62 L18.824 56 L18.824 68 L29.216 74 Z" fill="var(--splash-cell-fill)" opacity="0.45"/>
  <path d="M18.824 56 L8.432 50 L8.432 62 L18.824 68 Z" fill="var(--splash-cell-fill)" opacity="0.15"/>
  <path d="M50 86 L39.608 80 L39.608 92 L50 98 Z" fill="var(--splash-cell-fill)" opacity="0.55"/>
  <path d="M39.608 80 L29.216 74 L29.216 86 L39.608 92 Z" fill="var(--splash-cell-fill)" opacity="0.2"/>
  <path d="M29.216 74 L18.824 68 L18.824 80 L29.216 86 Z" fill="var(--splash-cell-fill)" opacity="0.35"/>
  <path d="M18.824 68 L8.432 62 L8.432 74 L18.824 80 Z" fill="var(--splash-cell-fill)" opacity="0.1"/>
  <path d="M50 50 L91.568 26 L91.568 74 L50 98 Z" fill="var(--splash-face-fill)" stroke="var(--splash-stroke)" stroke-width="2" stroke-linejoin="round"/>
  <path d="M50 50 L60.392 44 L60.392 56 L50 62 Z" fill="var(--splash-cell-fill)" opacity="0.3"/>
  <path d="M60.392 44 L70.784 38 L70.784 50 L60.392 56 Z" fill="var(--splash-cell-fill)" opacity="0.15"/>
  <path d="M70.784 38 L81.176 32 L81.176 44 L70.784 50 Z" fill="var(--splash-cell-fill)" opacity="0.45"/>
  <path d="M81.176 32 L91.568 26 L91.568 38 L81.176 44 Z" fill="var(--splash-cell-fill)" opacity="0.25"/>
  <path d="M50 62 L60.392 56 L60.392 68 L50 74 Z" fill="var(--splash-cell-fill)" opacity="0.5"/>
  <path d="M60.392 56 L70.784 50 L70.784 62 L60.392 68 Z" fill="var(--splash-cell-fill)" opacity="0.35"/>
  <path d="M70.784 50 L81.176 44 L81.176 56 L70.784 62 Z" fill="var(--splash-cell-fill)" opacity="0.1"/>
  <path d="M81.176 44 L91.568 38 L91.568 50 L81.176 56 Z" fill="var(--splash-cell-fill)" opacity="0.4"/>
  <path d="M50 74 L60.392 68 L60.392 80 L50 86 Z" fill="var(--splash-cell-fill)" opacity="0.2"/>
  <path d="M60.392 68 L70.784 62 L70.784 74 L60.392 80 Z" fill="var(--splash-cell-fill)" opacity="0.55"/>
  <path d="M70.784 62 L81.176 56 L81.176 68 L70.784 74 Z" fill="var(--splash-cell-fill)" opacity="0.3"/>
  <path d="M81.176 56 L91.568 50 L91.568 62 L81.176 68 Z" fill="var(--splash-cell-fill)" opacity="0.15"/>
  <path d="M50 86 L60.392 80 L60.392 92 L50 98 Z" fill="var(--splash-cell-fill)" opacity="0.45"/>
  <path d="M60.392 80 L70.784 74 L70.784 86 L60.392 92 Z" fill="var(--splash-cell-fill)" opacity="0.25"/>
  <path d="M70.784 74 L81.176 68 L81.176 80 L70.784 86 Z" fill="var(--splash-cell-fill)" opacity="0.4"/>
  <path d="M81.176 68 L91.568 62 L91.568 74 L81.176 80 Z" fill="var(--splash-cell-fill)" opacity="0.2"/>
  <path d="M50 2 L8.432 26 L50 50 L91.568 26 Z" fill="none" stroke="var(--splash-stroke)" stroke-width="2" stroke-linejoin="round"/>
  <g transform="matrix(0.866, 0.5, -0.866, 0.5, 50, 26) scale(0.75)">
    <path fill-rule="evenodd" clip-rule="evenodd" d="M-16 -20 L16 -20 L16 20 L-16 20 Z M-8 -12 L-8 12 L8 12 L8 -12 Z" fill="var(--splash-logo-fill)"/>
    <path d="M-8 -4 L8 -4 L8 12 L-8 12 Z" fill="var(--splash-logo-fill)" fill-opacity="0.4"/>
  </g>
</svg>`;

export const buildQuitPageHtml = ({ locale, colors = {} } = {}) => {
  const resolvedLocale = normalizeQuitLocale(locale);
  const copy = QUIT_COPY[resolvedLocale];
  const backgroundLight = safeColor(colors.backgroundLight, '#f5f5f4');
  const foregroundLight = safeColor(colors.foregroundLight, '#1c1917');
  const backgroundDark = safeColor(colors.backgroundDark, '#0c0a09');
  const foregroundDark = safeColor(colors.foregroundDark, '#fafaf9');

  return `<!doctype html>
<html lang="${escapeHtml(resolvedLocale)}">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(copy.title)}</title>
  <style>
    :root { color-scheme: light dark; --bg: ${backgroundLight}; --fg: ${foregroundLight}; --splash-stroke: var(--fg); --splash-face-fill: rgba(0, 0, 0, 0.15); --splash-cell-fill: rgba(0, 0, 0, 0.4); --splash-logo-fill: var(--splash-stroke); }
    @media (prefers-color-scheme: dark) { :root { --bg: ${backgroundDark}; --fg: ${foregroundDark}; --splash-face-fill: rgba(255, 255, 255, 0.15); --splash-cell-fill: rgba(255, 255, 255, 0.35); } }
    @supports (color: color-mix(in srgb, white 50%, transparent)) { :root { --splash-face-fill: color-mix(in srgb, var(--splash-stroke) 15%, transparent); --splash-cell-fill: color-mix(in srgb, var(--splash-stroke) 35%, transparent); } }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; overflow: hidden; background: var(--bg); color: var(--fg); font-family: "SF Pro Text", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; }
    main { display: grid; justify-items: center; gap: 22px; padding: 32px; text-align: center; }
    svg { display: block; }
    h1 { margin: 0; font-size: 20px; font-weight: 600; letter-spacing: -.01em; }
    p { margin: -10px 0 0; font-size: 13px; opacity: .62; }
  </style>
</head>
<body>
  <main role="status" aria-live="polite">
    ${buildSplashLogoSvg({ decorative: true })}
    <h1>${escapeHtml(copy.title)}</h1>
    <p>${escapeHtml(copy.detail)}</p>
  </main>
</body>
</html>`;
};
