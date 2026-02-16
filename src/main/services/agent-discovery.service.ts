/**
 * Agent Discovery Service - Parses AGENTS.md files
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { Agent, AgentDiscoveryResult, CastleAgentConfig } from '../../shared/types/agent.types';
import { AGENTS_MD_FILENAMES, BUILTIN_AGENT_COLORS } from '../../shared/constants';

/** Generate a deterministic UUID v4-format ID from a stable key (name + source) */
function stableAgentId(name: string, source: string): string {
  const hash = crypto.createHash('sha256').update(`${source}:${name}`).digest('hex');
  // Format as UUID v4: 8-4-4-4-12
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    '4' + hash.slice(13, 16),   // version nibble
    ((parseInt(hash[16], 16) & 0x3) | 0x8).toString(16) + hash.slice(17, 20), // variant
    hash.slice(20, 32)
  ].join('-');
}

interface CastleConfig {
  agents?: CastleAgentConfig[];
}

export class AgentDiscoveryService {
  private builtinAgentsPath: string;

  constructor() {
    // In production, this will be in resources folder
    // In development, it's in the project root
    const isDev = process.env.NODE_ENV === 'development' || !process.env.NODE_ENV;
    if (isDev) {
      this.builtinAgentsPath = path.join(process.cwd(), 'resources', 'agents.md');
    } else {
      this.builtinAgentsPath = path.join(process.resourcesPath, 'resources', 'agents.md');
    }
  }

  /**
   * Save agent configurations to the builtin agents.md file
   */
  saveBuiltinConfig(agents: CastleAgentConfig[]): void {
    const yamlLines: string[] = ['agents:'];
    for (const agent of agents) {
      yamlLines.push(`  - name: ${agent.name}`);
      if (agent.icon) yamlLines.push(`    icon: ${agent.icon}`);
      if (agent.color) yamlLines.push(`    color: "${agent.color}"`);
      if (agent.description) yamlLines.push(`    description: ${agent.description}`);
      if (agent.systemPrompt) {
        yamlLines.push(`    systemPrompt: |`);
        for (const line of agent.systemPrompt.split('\n')) {
          yamlLines.push(`      ${line}`);
        }
      }
      yamlLines.push('');
    }

    const configBlock = yamlLines.join('\n').trimEnd();
    const mdContent = [
      `# Castle Built-in Agents`,
      ``,
      `<!-- castle-config`,
      configBlock,
      `-->`,
      ``,
      `## About Castle Agents`,
      ``,
      `Castle provides multiple specialized AI agents to help with different aspects of software development. Each agent has a specific focus and expertise.`,
      ``,
    ].join('\n');

    fs.writeFileSync(this.builtinAgentsPath, mdContent, 'utf-8');
  }

  /**
   * Discover agents from both builtin and workspace AGENTS.md files
   */
  async discoverAgents(workspacePath: string): Promise<AgentDiscoveryResult> {
    const builtinAgents = await this.parseBuiltinAgents();
    const workspaceAgents = await this.parseWorkspaceAgents(workspacePath);

    // Combine agents, workspace agents can override builtin ones by name
    const agentMap = new Map<string, Agent>();
    
    for (const agent of builtinAgents) {
      agentMap.set(agent.name.toLowerCase(), agent);
    }
    
    for (const agent of workspaceAgents) {
      agentMap.set(agent.name.toLowerCase(), agent);
    }

    return {
      builtinAgents,
      workspaceAgents,
      combined: Array.from(agentMap.values())
    };
  }

  /**
   * Parse the builtin agents.md file
   */
  private async parseBuiltinAgents(): Promise<Agent[]> {
    try {
      if (!fs.existsSync(this.builtinAgentsPath)) {
        console.log('No builtin agents.md found, using defaults');
        return this.getDefaultAgents();
      }

      const content = fs.readFileSync(this.builtinAgentsPath, 'utf-8');
      return this.parseAgentsMd(content, 'builtin');
    } catch (error) {
      console.error('Error parsing builtin agents:', error);
      return this.getDefaultAgents();
    }
  }

  /**
   * Parse workspace AGENTS.md file
   */
  private async parseWorkspaceAgents(workspacePath: string): Promise<Agent[]> {
    for (const filename of AGENTS_MD_FILENAMES) {
      const filePath = path.join(workspacePath, filename);
      
      if (fs.existsSync(filePath)) {
        try {
          const content = fs.readFileSync(filePath, 'utf-8');
          return this.parseAgentsMd(content, 'workspace');
        } catch (error) {
          console.error(`Error parsing ${filePath}:`, error);
        }
      }
    }

    return [];
  }

  /**
   * Parse AGENTS.md content and extract Castle agent configurations
   */
  private parseAgentsMd(content: string, source: 'builtin' | 'workspace'): Agent[] {
    const agents: Agent[] = [];

    // Look for Castle configuration in HTML comments
    const castleConfigRegex = /<!--\s*castle-config\s*([\s\S]*?)-->/;
    const match = content.match(castleConfigRegex);

    if (match) {
      try {
        // Parse YAML-like configuration
        const configContent = match[1].trim();
        const config = this.parseYamlLikeConfig(configContent);
        
        if (config.agents && Array.isArray(config.agents)) {
          for (let i = 0; i < config.agents.length; i++) {
            const agentConfig = config.agents[i];
            agents.push({
              id: stableAgentId(agentConfig.name, source),
              name: agentConfig.name,
              description: agentConfig.description || `${agentConfig.name} agent`,
              icon: agentConfig.icon,
              color: agentConfig.color || BUILTIN_AGENT_COLORS[i % BUILTIN_AGENT_COLORS.length],
              systemPrompt: agentConfig.systemPrompt,
              source
            });
          }
        }
      } catch (error) {
        console.error('Error parsing Castle config:', error);
      }
    }

    // If no Castle config found, create a default agent from the file
    if (agents.length === 0) {
      const fallbackName = source === 'builtin' ? 'General Assistant' : 'Workspace Agent';
      agents.push({
        id: stableAgentId(fallbackName, source),
        name: fallbackName,
        description: source === 'builtin' 
          ? 'General purpose coding assistant' 
          : 'Agent configured for this workspace',
        icon: source === 'builtin' ? '🤖' : '📁',
        color: BUILTIN_AGENT_COLORS[0],
        systemPrompt: this.extractSystemPrompt(content),
        source
      });
    }

    return agents;
  }

  /**
   * Simple YAML-like parser for Castle config
   */
  private parseYamlLikeConfig(content: string): CastleConfig {
    const config: CastleConfig = { agents: [] };
    const lines = content.split('\n');
    
    let currentAgent: Partial<CastleAgentConfig> | null = null;
    let inSystemPrompt = false;
    let systemPromptLines: string[] = [];
    let systemPromptIndent = 0;

    for (const line of lines) {
      const trimmed = line.trim();
      
      // Skip empty lines and comments
      if (!trimmed || trimmed.startsWith('#')) continue;

      // Check for agents array start
      if (trimmed === 'agents:') continue;

      // Check for new agent (starts with -)
      if (trimmed.startsWith('- name:')) {
        // Save previous agent
        if (currentAgent && currentAgent.name) {
          if (inSystemPrompt && systemPromptLines.length > 0) {
            currentAgent.systemPrompt = systemPromptLines.join('\n').trim();
          }
          config.agents!.push(currentAgent as CastleAgentConfig);
        }
        
        // Start new agent
        currentAgent = {
          name: trimmed.replace('- name:', '').trim()
        };
        inSystemPrompt = false;
        systemPromptLines = [];
        continue;
      }

      if (!currentAgent) continue;

      // Handle multiline systemPrompt
      if (inSystemPrompt) {
        const lineIndent = line.search(/\S/);
        if (lineIndent >= systemPromptIndent || trimmed === '') {
          systemPromptLines.push(trimmed);
          continue;
        } else {
          // End of systemPrompt
          currentAgent.systemPrompt = systemPromptLines.join('\n').trim();
          inSystemPrompt = false;
        }
      }

      // Parse agent properties
      if (trimmed.startsWith('icon:')) {
        currentAgent.icon = trimmed.replace('icon:', '').trim();
      } else if (trimmed.startsWith('color:')) {
        currentAgent.color = trimmed.replace('color:', '').trim().replace(/['"]/g, '');
      } else if (trimmed.startsWith('description:')) {
        currentAgent.description = trimmed.replace('description:', '').trim();
      } else if (trimmed.startsWith('systemPrompt:')) {
        const value = trimmed.replace('systemPrompt:', '').trim();
        if (value === '|') {
          // Multiline string
          inSystemPrompt = true;
          systemPromptIndent = line.search(/\S/) + 2;
          systemPromptLines = [];
        } else {
          currentAgent.systemPrompt = value;
        }
      }
    }

    // Save last agent
    if (currentAgent && currentAgent.name) {
      if (inSystemPrompt && systemPromptLines.length > 0) {
        currentAgent.systemPrompt = systemPromptLines.join('\n').trim();
      }
      config.agents!.push(currentAgent as CastleAgentConfig);
    }

    return config;
  }

  /**
   * Extract system prompt from AGENTS.md content
   */
  private extractSystemPrompt(content: string): string | undefined {
    // Remove the Castle config block
    const withoutConfig = content.replace(/<!--\s*castle-config[\s\S]*?-->/, '').trim();
    
    if (withoutConfig.length > 0) {
      return `Use the following project guidelines:\n\n${withoutConfig}`;
    }
    
    return undefined;
  }

  /**
   * Get default agents when no agents.md is found
   */
  private getDefaultAgents(): Agent[] {
    return [
      {
        id: stableAgentId('General Assistant', 'builtin'),
        name: 'General Assistant',
        description: 'All-purpose coding help',
        icon: '🤖',
        color: BUILTIN_AGENT_COLORS[0],
        source: 'builtin'
      },
      {
        id: stableAgentId('Researcher', 'builtin'),
        name: 'Researcher',
        description: 'Researches tasks and produces detailed analysis documents',
        icon: '🔬',
        color: '#06B6D4',
        systemPrompt: `You are a research specialist. When given a task, you produce a thorough
research document in Markdown format. Your output should include:
- An executive summary of the task
- Technical analysis and feasibility
- Proposed approach with step-by-step breakdown
- Key considerations, risks, and edge cases
- Relevant code references and file locations in the codebase
- Estimated complexity and dependencies
- Recommended implementation order
Structure your output as a well-organized Markdown document with clear
headings, bullet points, and code references. Be thorough but concise.`,
        source: 'builtin'
      },
      {
        id: stableAgentId('Debugger', 'builtin'),
        name: 'Debugger',
        description: 'Diagnoses bugs and suggests fixes',
        icon: '🐛',
        color: '#EF4444',
        systemPrompt: `You are a debugging specialist. Your job is to systematically diagnose
issues and suggest precise fixes. When given a bug report, you should:
- Reproduce the problem by tracing the code path described
- Identify the root cause through systematic analysis
- Examine relevant stack traces, error messages, and logs
- Suggest where to add logging or breakpoints for further diagnosis
- Propose a concrete fix with specific code changes
- Consider edge cases and potential regressions from the fix
Structure your output under a "## Diagnosis and Suggested Fix" heading
with subsections for: Symptoms, Root Cause Analysis, Suggested Fix,
and Verification Steps. Be precise and reference specific files and
line numbers when possible.`,
        source: 'builtin'
      }
    ];
  }
}
