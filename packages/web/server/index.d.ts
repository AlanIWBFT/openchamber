import type { Express } from "express";
import type { Server } from "http";

export type OpenCodeStartupState =
  | { phase: "idle" | "launching" | "migrating" | "ready" }
  | { phase: "failed"; error: string };

export type OpenCodeStartupResult =
  | { status: "ready" }
  | { status: "failed"; error: string };

export interface WebUiServerController {
  expressApp: Express;
  httpServer: Server;
  getPort: () => number | null;
  getOpenCodePort: () => number | null;
  getQuitRiskStatus: () => {
    tunnel: { active: boolean };
    scheduledTasks: {
      hasEnabledScheduledTasks: boolean;
      hasRunningScheduledTasks: boolean;
      enabledScheduledTasksCount: number;
      runningScheduledTasksCount: number;
    };
    sessionActivity: {
      hasRunningSessions: boolean;
      runningSessionsCount: number;
    };
  };
  isReady: () => boolean;
  getOpenCodeStartupState: () => OpenCodeStartupState;
  onOpenCodeStartupState: (listener: (state: OpenCodeStartupState) => void) => () => void;
  waitForOpenCodeStartup: () => Promise<OpenCodeStartupResult>;
  restartOpenCode: () => Promise<void>;
  stop: (options?: { exitProcess?: boolean; deadline?: number }) => Promise<void>;
}

export interface StartWebUiServerOptions {
  port?: number;
  host?: string;
  attachSignals?: boolean;
  exitOnShutdown?: boolean;
  uiPassword?: string | null;
}

export declare function startWebUiServer(
  options?: StartWebUiServerOptions
): Promise<WebUiServerController>;

export declare function gracefulShutdown(options?: { exitProcess?: boolean; deadline?: number }): Promise<void>;
export declare function getManagedOpenCodeProcessInfo(): { managed: boolean; pid: number | null; port: number | null };
export declare function setupProxy(app: Express): void;
export declare function restartOpenCode(): Promise<void>;
export declare function stopDesktopBackgroundResources(): void;
export declare function stopManagedOpenCode(options?: { deadline?: number }): Promise<{ finalized: boolean }>;
export declare function parseArgs(argv?: string[]): {
  port: number;
  host?: string;
  uiPassword: string | null;
  tryCfTunnel: boolean;
  tunnelProvider?: string;
  tunnelMode?: string;
  tunnelConfigPath?: string | null;
  tunnelToken?: string;
  tunnelHostname?: string;
};
