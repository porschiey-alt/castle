/**
 * Castle - Electron Main Process Entry Point
 */

import { app, BrowserWindow, ipcMain, Menu, dialog } from 'electron';
import * as path from 'path';
import { WindowManager } from './window';
import { registerIpcHandlers, ipcHandlerRegistry } from './ipc';
import { DatabaseService } from './services/database.service';
import { AgentDiscoveryService } from './services/agent-discovery.service';
import { ProcessManagerService } from './services/process-manager.service';
import { DirectoryService } from './services/directory.service';
import { GitWorktreeService } from './services/git-worktree.service';
import { TailscaleServerService } from './services/tailscale-server.service';
import { WsBridgeService } from './services/ws-bridge.service';
import { EventBroadcaster } from './services/event-broadcaster';
import { IPC_CHANNELS } from '../shared/types/ipc.types';
import { createLogger } from './services/logger.service';

const log = createLogger('App');

// On Windows, refresh PATH from the registry so tools installed after
// the parent shell was opened (e.g. gh, git) are discoverable.
if (process.platform === 'win32') {
  try {
    const { execSync } = require('child_process');
    // Read system and user PATH directly from the registry
    const sysPath = execSync(
      'reg query "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment" /v Path',
      { encoding: 'utf-8' }
    ).match(/REG_(?:EXPAND_)?SZ\s+(.*)/)?.[1]?.trim() || '';
    const userPath = execSync(
      'reg query "HKCU\\Environment" /v Path',
      { encoding: 'utf-8' }
    ).match(/REG_(?:EXPAND_)?SZ\s+(.*)/)?.[1]?.trim() || '';
    if (sysPath || userPath) {
      process.env.PATH = [sysPath, userPath, process.env.PATH].filter(Boolean).join(';');
    }
  } catch { /* ignore — non-critical */ }
}

// Services
let windowManager: WindowManager;
let databaseService: DatabaseService;
let agentDiscoveryService: AgentDiscoveryService;
let processManagerService: ProcessManagerService;
let directoryService: DirectoryService;
let gitWorktreeService: GitWorktreeService;
let tailscaleServer: TailscaleServerService | null = null;
let wsBridge: WsBridgeService | null = null;
let broadcaster: EventBroadcaster | null = null;

/** Start (or restart) the Tailscale HTTP + WebSocket server */
async function startTailscaleServer(port: number): Promise<void> {
  log.info(`Starting Tailscale server on port ${port}`);
  // Stop existing instances
  if (wsBridge) { wsBridge.stop(); wsBridge = null; }
  if (tailscaleServer) { tailscaleServer.stop(); tailscaleServer = null; }

  tailscaleServer = new TailscaleServerService(port);
  await tailscaleServer.start();

  wsBridge = new WsBridgeService(ipcHandlerRegistry);
  const httpServer = tailscaleServer.getHttpServer();
  if (httpServer) {
    wsBridge.start(httpServer);
    if (broadcaster) {
      broadcaster.setRemoteSink(wsBridge);
    }
  }
  log.info(`Tailscale server started successfully on port ${port}`);
}

/** Stop the Tailscale HTTP + WebSocket server */
function stopTailscaleServer(): void {
  log.info('Stopping Tailscale server');
  if (wsBridge) { wsBridge.stop(); wsBridge = null; }
  if (tailscaleServer) { tailscaleServer.stop(); tailscaleServer = null; }
  if (broadcaster) { broadcaster.setRemoteSink(null); }
}

async function initializeServices(): Promise<void> {
  log.info('Initializing Castle services...');
  
  // Initialize database
  databaseService = new DatabaseService();
  await databaseService.initialize();
  log.info('Database service initialized');
  
  // Initialize other services
  directoryService = new DirectoryService(databaseService);
  agentDiscoveryService = new AgentDiscoveryService();
  processManagerService = new ProcessManagerService();
  gitWorktreeService = new GitWorktreeService();
  
  log.info('All services initialized successfully');
}

async function createWindow(): Promise<void> {
  // Get saved window bounds from database
  const settings = await databaseService.getSettings();
  
  windowManager = new WindowManager({
    width: settings.windowBounds?.width || 1200,
    height: settings.windowBounds?.height || 800,
    x: settings.windowBounds?.x,
    y: settings.windowBounds?.y,
    isMaximized: settings.windowBounds?.isMaximized || false
  });
  
  const mainWindow = windowManager.createMainWindow();

  // Create event broadcaster for fan-out to Electron + remote clients
  broadcaster = new EventBroadcaster(mainWindow);

  // Attach WebSocket bridge if Tailscale server is already running
  if (wsBridge) {
    broadcaster.setRemoteSink(wsBridge);
  }
  
  // Register IPC handlers
  registerIpcHandlers({
    databaseService,
    agentDiscoveryService,
    processManagerService,
    directoryService,
    gitWorktreeService,
    mainWindow,
    broadcaster
  });

  // Register Tailscale control handlers
  ipcMain.handle(IPC_CHANNELS.TAILSCALE_RESTART, async (_event, { port }: { port: number }) => {
    try {
      await startTailscaleServer(port);
      return { running: true, port };
    } catch (error) {
      return { running: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle(IPC_CHANNELS.TAILSCALE_STATUS, () => {
    return {
      running: tailscaleServer?.isRunning() ?? false,
      port: tailscaleServer?.getPort() ?? null,
    };
  });
  
  // Save window bounds on close
  mainWindow.on('close', async () => {
    const bounds = mainWindow.getBounds();
    const isMaximized = mainWindow.isMaximized();
    
    await databaseService.updateSettings({
      windowBounds: {
        ...bounds,
        isMaximized
      }
    });
  });
  
  // Handle directory from command line argument
  const args = process.argv.slice(2);
  if (args.length > 0 && !args[0].startsWith('-')) {
    const dirPath = path.resolve(args[0]);
    directoryService.setCurrentDirectory(dirPath);
  }
}

// App lifecycle
app.whenReady().then(async () => {
  try {
    Menu.setApplicationMenu(null);
    await initializeServices();
    await createWindow();

    // Start Tailscale server after IPC handlers are registered
    const settings = await databaseService.getSettings();
    if (settings.tailscaleEnabled) {
      try {
        await startTailscaleServer(settings.tailscalePort || 39417);
      } catch (error) {
        log.error('Failed to start Tailscale server', error);
      }
    }

    // Clean up orphaned worktrees on startup
    try {
      const currentDir = directoryService.getCurrentDirectory();
      if (currentDir && gitWorktreeService.isGitRepo(currentDir)) {
        log.info('Cleaning up orphaned worktrees on startup');
        const allTasks = await databaseService.getTasks();
        const activeTaskIds = new Set(
          allTasks
            .filter(t => t.worktreePath && t.state !== 'done')
            .map(t => t.id)
        );
        await gitWorktreeService.cleanupOrphans(currentDir, activeTaskIds);
      }
    } catch (error) {
      log.warn('Worktree orphan cleanup failed', error);
    }

    // Periodic git worktree prune (every 30 minutes)
    setInterval(async () => {
      try {
        const dir = directoryService.getCurrentDirectory();
        if (dir && gitWorktreeService.isGitRepo(dir)) {
          const { execFile: execFileCb } = require('child_process');
          const repoRoot = gitWorktreeService.getRepoRoot(dir);
          execFileCb('git', ['worktree', 'prune'], { cwd: repoRoot }, () => {});
        }
      } catch { /* non-critical */ }
    }, 30 * 60 * 1000);
    
    app.on('activate', async () => {
      // On macOS, re-create window when dock icon is clicked
      if (BrowserWindow.getAllWindows().length === 0) {
        await createWindow();
      }
    });
  } catch (error) {
    log.error('Failed to initialize Castle', error);
    dialog.showErrorBox('Initialization Error', 
      `Failed to start Castle: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
    app.quit();
  }
});

app.on('window-all-closed', () => {
  log.info('All windows closed, stopping agent sessions');
  // Stop all agent sessions
  if (processManagerService) {
    processManagerService.stopAllSessions();
  }
  
  // On macOS, keep app running until explicitly quit
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', async () => {
  log.info('Application quitting, cleaning up resources');
  // Cleanup
  if (processManagerService) {
    processManagerService.stopAllSessions();
  }
  stopTailscaleServer();
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  log.error('Uncaught exception', error);
});

process.on('unhandledRejection', (reason, promise) => {
  log.error('Unhandled rejection', { promise, reason });
});
