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

  // Helper to wire up output/complete/error/permission listeners for a session
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

    processManagerService.onPermissionRequest(sessionId, (data) => {
      mainWindow.webContents.send(IPC_CHANNELS.PERMISSION_REQUEST, data);
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
  ipcMain.on(IPC_CHANNELS.PERMISSION_RESPONSE, (_event, { requestId, agentId, optionId }) => {
    processManagerService.respondToPermission(agentId, requestId, optionId);
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

  // ============ Task Handlers ============

  ipcMain.handle(IPC_CHANNELS.TASKS_GET_ALL, async (_event, { state, kind } = {}) => {
    const projectPath = directoryService.getCurrentDirectory();
    return databaseService.getTasks(state, kind, projectPath || undefined);
  });

  ipcMain.handle(IPC_CHANNELS.TASKS_GET, async (_event, { taskId }) => {
    return databaseService.getTask(taskId);
  });

  ipcMain.handle(IPC_CHANNELS.TASKS_CREATE, async (_event, input) => {
    const projectPath = directoryService.getCurrentDirectory();
    return databaseService.createTask(input, projectPath || undefined);
  });

  ipcMain.handle(IPC_CHANNELS.TASKS_UPDATE, async (_event, { taskId, updates }) => {
    return databaseService.updateTask(taskId, updates);
  });

  ipcMain.handle(IPC_CHANNELS.TASKS_DELETE, async (_event, { taskId }) => {
    return databaseService.deleteTask(taskId);
  });

  ipcMain.handle(IPC_CHANNELS.TASKS_LABELS_GET_ALL, async () => {
    return databaseService.getTaskLabels();
  });

  ipcMain.handle(IPC_CHANNELS.TASKS_LABELS_CREATE, async (_event, { name, color }) => {
    return databaseService.createTaskLabel(name, color);
  });

  ipcMain.handle(IPC_CHANNELS.TASKS_LABELS_DELETE, async (_event, { labelId }) => {
    return databaseService.deleteTaskLabel(labelId);
  });

  ipcMain.handle(IPC_CHANNELS.TASKS_RUN_RESEARCH, async (_event, { taskId, agentId, outputPath }) => {
    const task = await databaseService.getTask(taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);

    let agent: Agent | null | undefined = discoveredAgents.get(agentId);
    if (!agent) agent = await databaseService.getAgent(agentId);
    if (!agent) throw new Error(`Agent ${agentId} not found`);

    const workingDirectory = directoryService.getCurrentDirectory();
    if (!workingDirectory) throw new Error('No workspace directory selected');

    // Ensure agent has a session
    let sessionProcess = processManagerService.getSessionByAgentId(agentId);
    if (!sessionProcess) {
      const session = await processManagerService.startSession(agent, workingDirectory);
      subscribeToSession(session.id, agentId);
      sessionProcess = processManagerService.getSessionByAgentId(agentId);
      if (!sessionProcess) throw new Error('Failed to start research agent session');
    }

    // Build the research prompt
    const researchPrompt = `Research the following task and produce a detailed analysis document in Markdown format.\n\nTask: ${task.title}\n\nDescription:\n${task.description || '(no description provided)'}\n\nPlease provide a thorough research document covering technical analysis, proposed approach, considerations, and implementation guidance. Output ONLY the markdown document content.`;

    // Save agentId to task immediately
    await databaseService.updateTask(taskId, { researchAgentId: agentId });

    // Listen for completion to save research content
    const onComplete = async (message: { content: string }) => {
      // Save to task in database
      await databaseService.updateTask(taskId, { researchContent: message.content });

      // Also save to file
      const fs = require('fs');
      const path = require('path');
      const researchDir = outputPath || path.join(workingDirectory, 'research');
      if (!fs.existsSync(researchDir)) {
        fs.mkdirSync(researchDir, { recursive: true });
      }
      const safeTitle = task.title.replace(/[^a-zA-Z0-9-_ ]/g, '').replace(/\s+/g, '-').toLowerCase();
      const filePath = path.join(researchDir, `${safeTitle}.md`);
      fs.writeFileSync(filePath, message.content, 'utf-8');
      console.log(`[Research] Saved research to ${filePath}`);

      // Notify renderer that research is complete
      mainWindow.webContents.send(IPC_CHANNELS.CHAT_STREAM_COMPLETE, {
        id: taskId,
        agentId,
        role: 'assistant',
        content: message.content,
        timestamp: new Date()
      });
    };

    processManagerService.onComplete(sessionProcess.session.id, onComplete);

    // Send the prompt (async — responses come via events)
    processManagerService.sendMessage(sessionProcess.session.id, researchPrompt).catch((error) => {
      console.error(`[Research] Error:`, error);
      mainWindow.webContents.send(IPC_CHANNELS.APP_ERROR, { agentId, error: String(error) });
    });

    return { taskId };
  });

  console.log('IPC handlers registered');
}
