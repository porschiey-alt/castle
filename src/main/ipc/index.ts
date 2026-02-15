/**
 * IPC Handler Registration
 */

import { BrowserWindow, ipcMain } from 'electron';
import { DatabaseService } from '../services/database.service';
import { AgentDiscoveryService } from '../services/agent-discovery.service';
import { ProcessManagerService } from '../services/process-manager.service';
import { DirectoryService } from '../services/directory.service';
import { IPC_CHANNELS } from '../../shared/types/ipc.types';
import { v4 as uuidv4 } from 'uuid';
import { Agent } from '../../shared/types/agent.types';

export interface IpcServices {
  databaseService: DatabaseService;
  agentDiscoveryService: AgentDiscoveryService;
  processManagerService: ProcessManagerService;
  directoryService: DirectoryService;
  mainWindow: BrowserWindow;
}

// In-memory cache of discovered agents
let discoveredAgents: Map<string, Agent> = new Map();

export function registerIpcHandlers(services: IpcServices): void {
  const {
    databaseService,
    agentDiscoveryService,
    processManagerService,
    directoryService,
    mainWindow
  } = services;

  // ============ Directory Handlers ============

  ipcMain.handle(IPC_CHANNELS.DIRECTORY_SELECT, async () => {
    return directoryService.selectDirectory(mainWindow);
  });

  ipcMain.handle(IPC_CHANNELS.DIRECTORY_GET_CURRENT, () => {
    return directoryService.getCurrentDirectory();
  });

  ipcMain.handle(IPC_CHANNELS.DIRECTORY_GET_RECENT, async () => {
    return directoryService.getRecentDirectories();
  });

  // ============ Agent Handlers ============

  ipcMain.handle(IPC_CHANNELS.AGENTS_DISCOVER, async (_event, { workspacePath }) => {
    const result = await agentDiscoveryService.discoverAgents(workspacePath);
    
    // Cache discovered agents and save to database
    discoveredAgents.clear();
    for (const agent of result.combined) {
      discoveredAgents.set(agent.id, agent);
      // Also save to database for persistence
      await databaseService.saveAgent(agent);
    }
    
    return result;
  });

  ipcMain.handle(IPC_CHANNELS.AGENTS_START_SESSION, async (_event, { agentId, workingDirectory }) => {
    // First try to get from in-memory cache
    let agent: Agent | null | undefined = discoveredAgents.get(agentId);
    
    // If not in cache, try database
    if (!agent) {
      agent = await databaseService.getAgent(agentId);
    }
    
    if (!agent) {
      throw new Error(`Agent ${agentId} not found`);
    }

    const session = await processManagerService.startSession(agent, workingDirectory);
    subscribeToSession(session.id, agentId);
    return session;
  });

  ipcMain.handle(IPC_CHANNELS.AGENTS_STOP_SESSION, async (_event, { sessionId }) => {
    await processManagerService.stopSession(sessionId);
  });

  ipcMain.handle(IPC_CHANNELS.AGENTS_GET_SESSION, (_event, { agentId }) => {
    const sessionProcess = processManagerService.getSessionByAgentId(agentId);
    return sessionProcess?.session || null;
  });

  // ============ Chat Handlers ============

  // Helper to wire up output/complete/error listeners for a session
  function subscribeToSession(sessionId: string, agentId: string): void {
    processManagerService.onOutput(sessionId, (message) => {
      mainWindow.webContents.send(IPC_CHANNELS.CHAT_STREAM_CHUNK, message);
    });

    processManagerService.onComplete(sessionId, async (message) => {
      // Save assistant message to database
      const assistantMessage = await databaseService.saveMessage({
        agentId,
        role: 'assistant',
        content: message.content,
        timestamp: new Date()
      });
      mainWindow.webContents.send(IPC_CHANNELS.CHAT_STREAM_COMPLETE, assistantMessage);
    });

    processManagerService.onError(sessionId, (error) => {
      mainWindow.webContents.send(IPC_CHANNELS.APP_ERROR, { agentId, error });
    });
  }

  ipcMain.handle(IPC_CHANNELS.CHAT_SEND_MESSAGE, async (_event, { agentId, content }) => {
    // Save user message
    const userMessage = await databaseService.saveMessage({
      agentId,
      role: 'user',
      content,
      timestamp: new Date()
    });

    // Get session for agent, auto-starting one if needed
    let sessionProcess = processManagerService.getSessionByAgentId(agentId);
    if (!sessionProcess) {
      const workingDirectory = directoryService.getCurrentDirectory();
      if (!workingDirectory) {
        throw new Error('No workspace directory selected. Please open a project first.');
      }

      let agent: Agent | null | undefined = discoveredAgents.get(agentId);
      if (!agent) {
        agent = await databaseService.getAgent(agentId);
      }
      if (!agent) {
        throw new Error(`Agent ${agentId} not found`);
      }

      const session = await processManagerService.startSession(agent, workingDirectory);
      subscribeToSession(session.id, agentId);

      sessionProcess = processManagerService.getSessionByAgentId(agentId);
      if (!sessionProcess) {
        throw new Error('Failed to start session for agent');
      }
    }

    // Send message to Copilot CLI via ACP — runs async, responses come via events
    processManagerService.sendMessage(sessionProcess.session.id, content).catch((error) => {
      console.error(`[Agent ${agentId}] sendMessage error:`, error);
      mainWindow.webContents.send(IPC_CHANNELS.APP_ERROR, { agentId, error: String(error) });
    });

    return userMessage;
  });

  ipcMain.handle(IPC_CHANNELS.CHAT_GET_HISTORY, async (_event, { agentId, limit, offset }) => {
    return databaseService.getMessages(agentId, limit, offset);
  });

  ipcMain.handle(IPC_CHANNELS.CHAT_CLEAR_HISTORY, async (_event, { agentId }) => {
    await databaseService.clearHistory(agentId);
  });

  // ============ Permission Handlers ============

  ipcMain.handle(IPC_CHANNELS.PERMISSION_GET, async (_event, { agentId }) => {
    return databaseService.getPermissions(agentId);
  });

  ipcMain.handle(IPC_CHANNELS.PERMISSION_SET, async (_event, { agentId, permission, granted }) => {
    await databaseService.setPermission(agentId, permission, granted);
  });

  // Handle permission response from renderer
  ipcMain.on(IPC_CHANNELS.PERMISSION_RESPONSE, (_event, { requestId, response }) => {
    // This would be handled by a permission request queue
    // For now, just log it
    console.log(`Permission response for ${requestId}:`, response);
  });

  // ============ Settings Handlers ============

  ipcMain.handle(IPC_CHANNELS.SETTINGS_GET, async () => {
    return databaseService.getSettings();
  });

  ipcMain.handle(IPC_CHANNELS.SETTINGS_UPDATE, async (_event, updates) => {
    return databaseService.updateSettings(updates);
  });

  // ============ Window Handlers ============

  ipcMain.on(IPC_CHANNELS.WINDOW_MINIMIZE, () => {
    mainWindow.minimize();
  });

  ipcMain.on(IPC_CHANNELS.WINDOW_MAXIMIZE, () => {
    if (mainWindow.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow.maximize();
    }
  });

  ipcMain.on(IPC_CHANNELS.WINDOW_CLOSE, () => {
    mainWindow.close();
  });

  // ============ App Handlers ============

  ipcMain.handle(IPC_CHANNELS.APP_GET_ACTIVE_MODEL, () => {
    return processManagerService.getActiveModel();
  });

  console.log('IPC handlers registered');
}
