// Keep this list limited to modules whose complete import graphs pass
// preload-env-guard. Electron evaluates them while the login-shell probe runs.
import 'reflect-metadata';
import '@opencode-ai/sdk/v2';
import 'cron-parser';
import 'jose';
import 'jsonc-parser';
import 'luxon';
import 'yaml';

export const serverDependenciesPreloaded = true;
