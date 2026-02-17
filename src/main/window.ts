/**
 * Window Manager for Castle
 */

import { BrowserWindow, shell } from 'electron';
import * as path from 'path';
import { 
  DEFAULT_WINDOW_WIDTH, 
  DEFAULT_WINDOW_HEIGHT, 
  MIN_WINDOW_WIDTH, 
  MIN_WINDOW_HEIGHT,
  APP_NAME 
} from '../shared/constants';

export interface WindowOptions {
  width?: number;
  height?: number;
  x?: number;
  y?: number;
  isMaximized?: boolean;
}

export class WindowManager {
  private mainWindow: BrowserWindow | null = null;
  private options: WindowOptions;

  constructor(options: WindowOptions = {}) {
    this.options = options;
  }

  createMainWindow(): BrowserWindow {
    // Check if we should use dev server (only when ELECTRON_DEV_SERVER is set)
    const useDevServer = process.env['ELECTRON_DEV_SERVER'] === 'true';
    
    this.mainWindow = new BrowserWindow({
      width: this.options.width || DEFAULT_WINDOW_WIDTH,
      height: this.options.height || DEFAULT_WINDOW_HEIGHT,
      x: this.options.x,
      y: this.options.y,
      minWidth: MIN_WINDOW_WIDTH,
      minHeight: MIN_WINDOW_HEIGHT,
      title: APP_NAME,
      backgroundColor: '#1a1a2e', // Dark theme background
      show: false, // Don't show until ready
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        preload: path.join(__dirname, '../preload/index.js'),
        sandbox: false // Required for better-sqlite3
      },
      frame: false,
    });

    // Show window when ready to prevent visual flash
    this.mainWindow.once('ready-to-show', () => {
      if (this.mainWindow) {
        if (this.options.isMaximized) {
          this.mainWindow.maximize();
        }
        this.mainWindow.show();
      }
    });

    // Load the app
    if (useDevServer) {
      // Development with hot reload: load from Angular dev server
      this.mainWindow.loadURL('http://localhost:4200');
      // Open DevTools in development
      this.mainWindow.webContents.openDevTools();
    } else {
      // Production or dev without hot reload: load from built files
      const indexPath = path.join(__dirname, '../renderer/browser/index.html');
      console.log('Loading app from:', indexPath);
      this.mainWindow.loadFile(indexPath);
    }

    // Handle external links
    this.mainWindow.webContents.setWindowOpenHandler(({ url }) => {
      shell.openExternal(url);
      return { action: 'deny' };
    });

    // Handle window closed
    this.mainWindow.on('closed', () => {
      this.mainWindow = null;
    });

    return this.mainWindow;
  }

  getMainWindow(): BrowserWindow | null {
    return this.mainWindow;
  }

  minimize(): void {
    this.mainWindow?.minimize();
  }

  maximize(): void {
    if (this.mainWindow?.isMaximized()) {
      this.mainWindow.unmaximize();
    } else {
      this.mainWindow?.maximize();
    }
  }

  close(): void {
    this.mainWindow?.close();
  }
}
