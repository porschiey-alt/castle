/**
 * Castle - Electron Main Process Entry Point
 */

import { app, BrowserWindow, ipcMain, dialog } from 'electron';
import * as path from 'path';
import { WindowManager } from './window';
import { registerIpcHandlers } from './ipc';
import { DatabaseService } from './services/database.service';
import { AgentDiscoveryService } from './services/agent-discovery.service';
import { ProcessManagerService } from './services/process-manager.service';
import { DirectoryService } from './services/directory.service';

// Services
let windowManager: WindowManager;
let databaseService: DatabaseService;
let agentDiscoveryService: AgentDiscoveryService;
let processManagerService: ProcessManagerService;
let directoryService: DirectoryService;

async function initializeServices(): Promise<void> {
  console.log('Initializing Castle services...');
  
  // Initialize database
  databaseService = new DatabaseService();
  await databaseService.initialize();
  
  // Initialize other services
  directoryService = new DirectoryService(databaseService);
  agentDiscoveryService = new AgentDiscoveryService();
  processManagerService = new ProcessManagerService();
  
  console.log('Services initialized successfully');
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
  
  // Register IPC handlers
  registerIpcHandlers({
    databaseService,
    agentDiscoveryService,
    processManagerService,
    directoryService,
    mainWindow
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
    await initializeServices();
    await createWindow();
    
    app.on('activate', async () => {
      // On macOS, re-create window when dock icon is clicked
      if (BrowserWindow.getAllWindows().length === 0) {
        await createWindow();
      }
    });
  } catch (error) {
    console.error('Failed to initialize Castle:', error);
    dialog.showErrorBox('Initialization Error', 
      `Failed to start Castle: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
    app.quit();
  }
});

app.on('window-all-closed', () => {
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
  // Cleanup
  if (processManagerService) {
    processManagerService.stopAllSessions();
  }
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled rejection at:', promise, 'reason:', reason);
});
