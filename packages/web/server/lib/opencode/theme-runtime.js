export const createThemeRuntime = (dependencies) => {
  const {
    fsPromises,
    path,
    themesDir,
    maxThemeJsonBytes,
    logger,
  } = dependencies;

  const isNonEmptyString = (value) => typeof value === 'string' && value.trim().length > 0;
  const isValidThemeColor = (value) => isNonEmptyString(value);

  const normalizeThemeJson = (raw) => {
    if (!raw || typeof raw !== 'object') {
      return null;
    }

    const metadata = raw.metadata && typeof raw.metadata === 'object' ? raw.metadata : null;
    const colors = raw.colors && typeof raw.colors === 'object' ? raw.colors : null;
    if (!metadata || !colors) {
      return null;
    }

    const id = metadata.id;
    const name = metadata.name;
    const variant = metadata.variant;
    if (!isNonEmptyString(id) || !isNonEmptyString(name) || (variant !== 'light' && variant !== 'dark')) {
      return null;
    }

    const primary = colors.primary;
    const surface = colors.surface;
    const interactive = colors.interactive;
    const status = colors.status;
    const syntax = colors.syntax;
    const syntaxBase = syntax && typeof syntax === 'object' ? syntax.base : null;

    if (!primary || !surface || !interactive || !status || !syntaxBase) {
      return null;
    }

    // Authored inputs only. The UI resolves optional roles before rendering.
    const required = [
      primary.base,
      surface.background,
      surface.foreground,
      surface.muted,
      surface.mutedForeground,
      surface.elevated,
      interactive.border,
      status.error,
      status.warning,
      status.success,
      status.info,
      syntaxBase.keyword,
      syntaxBase.string,
      syntaxBase.number,
      syntaxBase.function,
      syntaxBase.variable,
      syntaxBase.type,
      syntaxBase.comment,
      syntaxBase.operator,
    ];

    if (!required.every(isValidThemeColor)) {
      return null;
    }

    const tags = Array.isArray(metadata.tags)
      ? metadata.tags.filter((tag) => typeof tag === 'string' && tag.trim().length > 0)
      : [];

    return {
      ...raw,
      metadata: {
        ...metadata,
        id: id.trim(),
        name: name.trim(),
        description: typeof metadata.description === 'string' ? metadata.description : '',
        version: typeof metadata.version === 'string' && metadata.version.trim().length > 0 ? metadata.version : '1.0.0',
        variant,
        tags,
      },
    };
  };

  const readCustomThemesFromDisk = async () => {
    try {
      const entries = await fsPromises.readdir(themesDir, { withFileTypes: true });
      const themes = [];
      const seen = new Set();

      for (const entry of entries) {
        if (!entry.isFile() && !entry.isSymbolicLink()) continue;
        if (!entry.name.toLowerCase().endsWith('.json')) continue;

        const filePath = path.join(themesDir, entry.name);
        try {
          const stat = await fsPromises.stat(filePath);
          if (!stat.isFile()) continue;
          if (stat.size > maxThemeJsonBytes) {
            logger.warn(`[themes] Skip ${entry.name}: too large (${stat.size} bytes)`);
            continue;
          }

          const rawText = await fsPromises.readFile(filePath, 'utf8');
          const parsed = JSON.parse(rawText);
          const normalized = normalizeThemeJson(parsed);
          if (!normalized) {
            logger.warn(`[themes] Skip ${entry.name}: invalid theme JSON`);
            continue;
          }

          const id = normalized.metadata.id;
          if (seen.has(id)) {
            logger.warn(`[themes] Skip ${entry.name}: duplicate theme id "${id}"`);
            continue;
          }

          seen.add(id);
          themes.push(normalized);
        } catch (error) {
          logger.warn(`[themes] Failed to read ${entry.name}:`, error);
        }
      }

      return themes;
    } catch (error) {
      // Missing dir is fine.
      if (error && typeof error === 'object' && error.code === 'ENOENT') {
        return [];
      }
      logger.warn('[themes] Failed to list custom themes dir:', error);
      return [];
    }
  };

  return {
    normalizeThemeJson,
    readCustomThemesFromDisk,
  };
};
