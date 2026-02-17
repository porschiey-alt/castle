# The System Prompt Is Never Actually Sent to the LLM — Bug Diagnosis

## Diagnosis and Suggested Fix

### Symptoms

The `systemPrompt` field can be edited in the agent dialog, persists correctly to
SQLite and `agents.md`, and is loaded back into the in-memory agent cache. However, the
agent behaves identically regardless of what the system prompt says — it has no
effect on LLM behavior.

### Root Cause Analysis

#### The pipeline works up to the injection point

1. **UI → Storage ✅** — The agent dialog saves `systemPrompt` via the database
   service (`system_prompt` column) and writes it to `agents.md` on disk.
2. **Discovery → Cache ✅** — `agent-discovery.service.ts` parses `agents.md` and
   extracts `systemPrompt` into the `Agent` object. The IPC layer caches discovered
   agents in the `discoveredAgents` map.
3. **Session creation ✅** — `startSession(agent, workingDirectory)` receives the full
   `Agent` object (including `systemPrompt`), but never uses it.

#### The injection gap

**File:** `src/main/services/process-manager.service.ts`

There are two places where the system prompt could be injected — neither does so:

**a) `startSession()` — session creation (lines 352–358)**

```typescript
const acpSession = await connection.newSession({
  cwd: workingDirectory,
  mcpServers
});
```

The ACP `NewSessionRequest` schema only accepts `cwd` and `mcpServers`. There is no
`systemPrompt` or `instructions` field in the protocol. So it **cannot** be injected at
session creation time via ACP.

**b) `sendMessage()` — each prompt (lines 430–435)**

```typescript
const response = await sessionProcess.connection.prompt({
  sessionId: sessionProcess.acpSessionId,
  prompt: [{ type: 'text', text: content }]
});
```

The ACP `PromptRequest` accepts `sessionId` and `prompt` (an array of `ContentBlock`).
This is where the system prompt **should** be injected, but it isn't — only the raw
user message text is sent.

Additionally, the `Agent` object is not stored on `SessionProcess`, so `sendMessage()`
has no access to the agent's `systemPrompt` even if it wanted to inject it.

**c) CLI flags**

The `copilot` CLI offers `--no-custom-instructions` but no `--system-prompt` flag. The
`--agent` flag selects a predefined agent, which is not the same as injecting custom
instructions. The Copilot CLI does support reading instructions from `AGENTS.md` /
`.github/copilot-instructions.md` files, but Castle manages its own agent system with
per-agent system prompts that need to be injected at the prompt level.

#### Why it occasionally might seem to partially work

The Copilot CLI automatically loads custom instructions from workspace files
(`.github/copilot-instructions.md`, `AGENTS.md`). If the workspace has these files,
the agent may exhibit behavior that appears influenced by the system prompt, but this
is coincidental — it's reading the workspace files, not the system prompt from Castle's
agent config.

### Suggested Fix

Since the ACP protocol has no system prompt field, the fix is to **prepend the system
prompt as an instruction block** in the `prompt` content array on the first message of
each session, and store the `Agent` reference on `SessionProcess` so `sendMessage()` can
access it.

#### 1. Store the `Agent` on `SessionProcess` and track first-message state

**File:** `src/main/services/process-manager.service.ts`

Add `agent` and `systemPromptSent` to the `SessionProcess` interface:

```diff
 interface SessionProcess {
+  agent: Agent;
   session: AgentSession;
   process: ChildProcess;
   connection: any;
   acpSessionId: string | null;
   eventEmitter: EventEmitter;
   contentBuffer: string;
   thinkingBuffer: string;
   toolCalls: Map<string, ToolCall>;
   todoItems: TodoItem[];
   segments: MessageSegment[];
   currentOperation: string;
+  systemPromptSent: boolean;
   capabilities: {
     canLoadSession: boolean;
     canResumeSession: boolean;
     canListSessions: boolean;
   };
 }
```

#### 2. Store the agent when creating the session

In `startSession()`, initialize the new fields:

```diff
     const sessionProcess: SessionProcess = {
+      agent,
       session,
       process: childProcess,
       connection: null!,
       acpSessionId: null,
       eventEmitter,
       contentBuffer: '',
       thinkingBuffer: '',
       toolCalls: new Map(),
       todoItems: [],
       segments: [],
       currentOperation: 'spawning',
+      systemPromptSent: false,
       capabilities: { canLoadSession: false, canResumeSession: false, canListSessions: false }
     };
```

#### 3. Prepend the system prompt on the first message

In `sendMessage()`, construct the prompt content array with the system prompt
prepended on the first prompt of the session:

```diff
     try {
       // Send prompt and wait for full response
       sessionProcess.currentOperation = 'prompt';
+
+      // Build prompt content blocks
+      const promptBlocks: Array<{ type: 'text'; text: string }> = [];
+
+      // Inject system prompt on the first message of the session
+      if (!sessionProcess.systemPromptSent && sessionProcess.agent.systemPrompt?.trim()) {
+        promptBlocks.push({
+          type: 'text',
+          text: `<system-instructions>\n${sessionProcess.agent.systemPrompt.trim()}\n</system-instructions>`
+        });
+        sessionProcess.systemPromptSent = true;
+      }
+
+      promptBlocks.push({ type: 'text', text: content });
+
       const response = await sessionProcess.connection.prompt({
         sessionId: sessionProcess.acpSessionId,
-        prompt: [{ type: 'text', text: content }]
+        prompt: promptBlocks
       });
```

#### Why `<system-instructions>` wrapper tags?

Wrapping the system prompt in XML-style tags makes it unambiguous to the LLM that this
is an instruction block, not part of the user's message. The Copilot CLI and
underlying LLM models recognize this pattern for distinguishing instructions from
conversation content. This also prevents the system prompt from confusing the agent
into responding to the instructions as if they were a question.

#### Why only on the first message?

The Copilot CLI maintains its own conversation history within the ACP session. The
system prompt only needs to be injected once — subsequent messages in the same session
will retain the context. Re-injecting on every message would waste tokens and
potentially confuse the model.

### Verification Steps

1. **Basic test:** Set an agent's system prompt to something distinctive (e.g.
   "Always respond in haiku format"). Send a message. Verify the response follows
   the system prompt's instructions.
2. **Multi-turn conversation:** After the first message, send follow-up messages.
   Verify the system prompt continues to influence behavior without being re-sent.
3. **No system prompt:** Use an agent with an empty/undefined system prompt. Verify
   messages are sent normally with no extra content block prepended.
4. **Session restart:** Stop and restart an agent session. Send a message. Verify the
   system prompt is injected again on the first message of the new session.
5. **Different agents:** Switch between agents with different system prompts. Verify
   each agent's session uses its own system prompt.
6. **Research/Implementation tasks:** Trigger a research or implementation task.
   Verify the system prompt is present in the first prompt sent for that task's
   session.
