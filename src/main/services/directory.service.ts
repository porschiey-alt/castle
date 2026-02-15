/**
 * Directory Service - Manages workspace directory selection
 */

import { dialog, BrowserWindow } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { DatabaseService } from './database.service';

export class DirectoryService {
  private currentDirectory: string | null = null;
  private databaseService: DatabaseService;

  constructor(databaseService: DatabaseService) {
    this.databaseService = databaseService;
  }

  /**
   * Open a directory selection dialog
   */
  async selectDirectory(parentWindow?: BrowserWindow): Promise<string | null> {
    const result = await dialog.showOpenDialog(parentWindow || BrowserWindow.getFocusedWindow()!, {
      properties: ['openDirectory'],
      title: 'Select Project Directory',
      buttonLabel: 'Open Project'
    });

    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }

    const selectedPath = result.filePaths[0];
    await this.setCurrentDirectory(selectedPath);
    
    return selectedPath;
  }

  /**
   * Set the current working directory
   */
  async setCurrentDirectory(dirPath: string): Promise<void> {
    // Validate directory exists
    if (!fs.existsSync(dirPath)) {
      throw new Error(`Directory does not exist: ${dirPath}`);
    }

    const stats = fs.statSync(dirPath);
    if (!stats.isDirectory()) {
      throw new Error(`Path is not a directory: ${dirPath}`);
    }

    this.currentDirectory = dirPath;
    
    // Add to recent directories
    await this.databaseService.addRecentDirectory(dirPath);
  }

  /**
   * Get the current working directory
   */
  getCurrentDirectory(): string | null {
    return this.currentDirectory;
  }

  /**
   * Get recent directories
   */
  async getRecentDirectories(): Promise<string[]> {
    const directories = await this.databaseService.getRecentDirectories();
    
    // Filter out directories that no longer exist
    return directories.filter(dir => fs.existsSync(dir));
  }

  /**
   * Check if a file exists in the current directory
   */
  fileExists(relativePath: string): boolean {
    if (!this.currentDirectory) return false;
    
    const fullPath = path.join(this.currentDirectory, relativePath);
    return fs.existsSync(fullPath);
  }

  /**
   * Read a file from the current directory
   */
  readFile(relativePath: string): string {
    if (!this.currentDirectory) {
      throw new Error('No directory selected');
    }
    
    const fullPath = path.join(this.currentDirectory, relativePath);
    
    if (!fs.existsSync(fullPath)) {
      throw new Error(`File not found: ${relativePath}`);
    }
    
    return fs.readFileSync(fullPath, 'utf-8');
  }

  /**
   * Get directory info
   */
  getDirectoryInfo(): { name: string; path: string } | null {
    if (!this.currentDirectory) return null;
    
    return {
      name: path.basename(this.currentDirectory),
      path: this.currentDirectory
    };
  }
}
