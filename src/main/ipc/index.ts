/**
 * IPC Handler Registration
 */

import { BrowserWindow, ipcMain } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { DatabaseService } from '../services/database.service';
import { AgentDiscoveryService } from '../services/agent-discovery.service';
import { ProcessManagerService } from '../services/process-manager.service';
import { DirectoryService } from '../services/directory.service';
import { IPC_CHANNELS } from '../../shared/types/ipc.types';
import { v4 as uuidv4 } from 'uuid';
import { Agent } from '../../shared/types/agent.types';
import { Task, ResearchComment } from '../../shared/types/task.types';

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

  ipcMain.handle(IPC_CHANNELS.DIRECTORY_SET_CURRENT, async (_event, { path }) => {
    await directoryService.setCurrentDirectory(path);
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

    processManagerService.onCancelled(sessionId, () => {
      mainWindow.webContents.send(IPC_CHANNELS.CHAT_CANCEL_MESSAGE, { agentId });
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

  ipcMain.handle(IPC_CHANNELS.CHAT_CANCEL_MESSAGE, async (_event, { agentId }) => {
    await processManagerService.cancelMessage(agentId);
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

  /** Compute the on-disk research/diagnosis file path for a task */
  function getResearchFilePath(task: Task, workingDirectory: string): string {
    const safeTitle = task.title.replace(/[^a-zA-Z0-9-_ ]/g, '').replace(/\s+/g, '-').toLowerCase();
    const subDir = task.kind === 'bug' ? path.join('research', 'diagnosis') : 'research';
    return path.join(workingDirectory, subDir, `${safeTitle}.md`);
  }

  /** Read research content from the on-disk file. If the file is missing, clear stale DB values. */
  function hydrateResearchFromFile(task: Task, workingDirectory: string | null): Task {
    if (!workingDirectory) return task;
    const filePath = getResearchFilePath(task, workingDirectory);
    try {
      if (fs.existsSync(filePath)) {
        const content = fs.readFileSync(filePath, 'utf-8');
        return { ...task, researchContent: content };
      }
    } catch { /* file unreadable, treat as missing */ }
    // File doesn't exist — clear stale DB research so the UI
    // prompts the user to run research again.
    if (task.researchContent) {
      return { ...task, researchContent: undefined, researchAgentId: undefined };
    }
    return task;
  }

  ipcMain.handle(IPC_CHANNELS.TASKS_GET_ALL, async (_event, { state, kind } = {}) => {
    const projectPath = directoryService.getCurrentDirectory();
    const tasks = await databaseService.getTasks(state, kind, projectPath || undefined);
    return tasks.map(t => hydrateResearchFromFile(t, projectPath));
  });

  ipcMain.handle(IPC_CHANNELS.TASKS_GET, async (_event, { taskId }) => {
    const task = await databaseService.getTask(taskId);
    if (!task) return null;
    const projectPath = directoryService.getCurrentDirectory();
    return hydrateResearchFromFile(task, projectPath);
  });

  ipcMain.handle(IPC_CHANNELS.TASKS_CREATE, async (_event, input) => {
    const projectPath = directoryService.getCurrentDirectory();
    return databaseService.createTask(input, projectPath || undefined);
  });

  ipcMain.handle(IPC_CHANNELS.TASKS_UPDATE, async (_event, { taskId, updates }) => {
    const updatedTask = await databaseService.updateTask(taskId, updates);

    // When a bug is marked done, notify the renderer so it can prompt to delete
    // the diagnosis file.
    if (updates.state === 'done' && updatedTask && updatedTask.kind === 'bug') {
      const projectPath = directoryService.getCurrentDirectory();
      if (projectPath) {
        const diagPath = getResearchFilePath(updatedTask, projectPath);
        if (fs.existsSync(diagPath)) {
          mainWindow.webContents.send(IPC_CHANNELS.TASKS_DIAGNOSIS_FILE_CLEANUP, {
            taskId,
            filePath: diagPath,
          });
        }
      }
    }

    return updatedTask;
  });

  ipcMain.handle(IPC_CHANNELS.TASKS_DELETE, async (_event, { taskId }) => {
    return databaseService.deleteTask(taskId);
  });

  ipcMain.handle(IPC_CHANNELS.TASKS_DELETE_DIAGNOSIS_FILE, async (_event, { filePath }: { filePath: string }) => {
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        console.log(`[Diagnosis] Deleted file: ${filePath}`);
        return { deleted: true };
      }
    } catch (error) {
      console.error(`[Diagnosis] Failed to delete file:`, error);
    }
    return { deleted: false };
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

    // Build the research prompt based on task kind
    const safeTitle = task.title.replace(/[^a-zA-Z0-9-_ ]/g, '').replace(/\s+/g, '-').toLowerCase();
    const researchDir = outputPath || path.join(workingDirectory, 'research');
    const diagnosisDir = path.join(researchDir, 'diagnosis');
    const expectedFilePath = task.kind === 'bug'
      ? path.join(diagnosisDir, `${safeTitle}.md`)
      : path.join(researchDir, `${safeTitle}.md`);

    let researchPrompt: string;

    if (task.kind === 'bug') {
      researchPrompt = [
        `Diagnose the following bug and suggest a fix.`,
        ``,
        `Bug: ${task.title}`,
        ``,
        `Description:`,
        task.description || '(no description provided)',
        ``,
        `Systematically analyze this bug. Identify the root cause and propose a concrete fix.`,
        `Structure your output under a "## Diagnosis and Suggested Fix" heading with subsections`,
        `for: Symptoms, Root Cause Analysis, Suggested Fix, and Verification Steps.`,
        ``,
        `Write the diagnosis to the file: ${expectedFilePath}`,
      ].join('\n');
    } else {
      researchPrompt = [
        `Research the following task and produce a detailed analysis document in Markdown format.`,
        ``,
        `Task: ${task.title}`,
        ``,
        `Description:`,
        task.description || '(no description provided)',
        ``,
        `Please provide a thorough research document covering technical analysis, proposed approach, considerations, and implementation guidance.`,
        ``,
        `Write the research document to the file: ${expectedFilePath}`,
      ].join('\n');
    }

    // Save agentId to task immediately
    await databaseService.updateTask(taskId, { researchAgentId: agentId });

    // Record start time to detect agent-created files
    const researchStartTime = Date.now();

    /** Send a follow-up prompt telling the agent to write the file */
    const promptAgentToWriteFile = () => {
      const followUp = `Your research output was not saved to disk. Please write the content you just produced to the file: ${expectedFilePath}`;
      const unsubFollowUp = processManagerService.onComplete(sessionProcess!.session.id, () => {
        unsubFollowUp();
        notifyComplete();
      });
      processManagerService.sendMessage(sessionProcess!.session.id, followUp).catch((error) => {
        console.error(`[Research] Follow-up error:`, error);
        mainWindow.webContents.send(IPC_CHANNELS.APP_ERROR, { agentId, error: String(error) });
      });
    };

    /** Notify the renderer that research is complete */
    const notifyComplete = () => {
      mainWindow.webContents.send(IPC_CHANNELS.CHAT_STREAM_COMPLETE, {
        id: taskId,
        agentId,
        role: 'assistant',
        content: '',
        timestamp: new Date()
      });
    };

    // Listen for completion
    const onComplete = async (message: { content: string }) => {
      // Check if the agent wrote the file during execution
      let agentWroteFile = false;
      try {
        if (fs.existsSync(expectedFilePath)) {
          const stat = fs.statSync(expectedFilePath);
          if (stat.mtimeMs >= researchStartTime) {
            agentWroteFile = true;
          }
        }
      } catch { /* treat as not written */ }

      if (agentWroteFile) {
        console.log(`[Research] Agent wrote file: ${expectedFilePath}`);
        notifyComplete();
      } else {
        // Agent didn't write the file — prompt it again
        console.log(`[Research] Agent did not write file, sending follow-up prompt`);
        promptAgentToWriteFile();
      }
    };

    const unsubscribeResearch = processManagerService.onComplete(sessionProcess.session.id, (message) => {
      unsubscribeResearch();
      onComplete(message);
    });

    // Send the prompt (async — responses come via events)
    processManagerService.sendMessage(sessionProcess.session.id, researchPrompt).catch((error) => {
      console.error(`[Research] Error:`, error);
      mainWindow.webContents.send(IPC_CHANNELS.APP_ERROR, { agentId, error: String(error) });
    });

    return { taskId };
  });

  // ============ Research Review Handler ============

  ipcMain.handle(IPC_CHANNELS.TASKS_SUBMIT_RESEARCH_REVIEW, async (_event, { taskId, comments, researchSnapshot }: { taskId: string; comments: ResearchComment[]; researchSnapshot: string }) => {
    const task = await databaseService.getTask(taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);
    if (!task.researchAgentId) throw new Error('No research agent assigned to task');

    const reviewId = uuidv4();
    const agentId = task.researchAgentId;

    // Persist the review
    await databaseService.createResearchReview({
      id: reviewId,
      taskId,
      comments,
      researchSnapshot,
      status: 'pending',
    });

    // Ensure agent has a session
    let sessionProcess = processManagerService.getSessionByAgentId(agentId);
    if (!sessionProcess) {
      let agent: Agent | null | undefined = discoveredAgents.get(agentId);
      if (!agent) agent = await databaseService.getAgent(agentId);
      if (!agent) throw new Error(`Agent ${agentId} not found`);
      const workDir = directoryService.getCurrentDirectory();
      if (!workDir) throw new Error('No workspace directory');
      const session = await processManagerService.startSession(agent, workDir);
      subscribeToSession(session.id, agentId);
      sessionProcess = processManagerService.getSessionByAgentId(agentId);
      if (!sessionProcess) throw new Error('Failed to start research agent session');
    }

    // Build revision prompt
    const commentBlock = comments.map((c: ResearchComment, i: number) =>
      `${i + 1}. [${c.anchor.blockType}: "${c.anchor.preview}..."]\n   Comment: ${c.body}`
    ).join('\n\n');

    const workDir = directoryService.getCurrentDirectory();
    const revisionFilePath = workDir ? getResearchFilePath(task, workDir) : null;

    const revisionPrompt = [
      `You previously produced the following research document for the task "${task.title}":`,
      ``,
      `---BEGIN RESEARCH---`,
      researchSnapshot,
      `---END RESEARCH---`,
      ``,
      `The reviewer has left the following comments requesting changes:`,
      ``,
      commentBlock,
      ``,
      `Please produce an updated version of the research document that addresses each comment.`,
      revisionFilePath
        ? `Write the revised document to the file: ${revisionFilePath}`
        : `Output ONLY the revised markdown document content. Do not include meta-commentary about the changes.`,
    ].join('\n');

    await databaseService.updateResearchReview(reviewId, { status: 'in_progress' });

    // Listen for completion to save revised content
    const onComplete = async (message: { content: string }) => {
      await databaseService.updateResearchReview(reviewId, {
        status: 'complete',
        revisedContent: message.content,
      });

      mainWindow.webContents.send(IPC_CHANNELS.CHAT_STREAM_COMPLETE, {
        id: taskId,
        agentId,
        role: 'assistant',
        content: message.content,
        timestamp: new Date(),
      });
    };

    const unsubscribeReview = processManagerService.onComplete(sessionProcess.session.id, (message) => {
      unsubscribeReview();
      onComplete(message);
    });
    processManagerService.sendMessage(sessionProcess.session.id, revisionPrompt).catch((error) => {
      console.error('[Research Review] Error:', error);
      databaseService.updateResearchReview(reviewId, { status: 'pending' });
      mainWindow.webContents.send(IPC_CHANNELS.APP_ERROR, { agentId, error: String(error) });
    });

    return { reviewId };
  });

  console.log('IPC handlers registered');
}
