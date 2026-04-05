# Agent Handoff

Lattik Studio uses a concierge + specialist model. The **Lattik Studio Assistant** triages every new conversation and routes to the right specialist agent. Specialists can pause, hand back, and resume with full canvas state preservation.

## Architecture

```
User
 |
 v
Lattik Studio Assistant (concierge)
 |-- handoff tool --> Specialist Agent (e.g. Data Architect)
 |                        |-- handback tool (pause) --> Assistant
 |                        |-- handback tool (complete) --> pop stack or Assistant
 |
 v
[task stack: saves paused specialist + canvas state]
```

## Roles

**Assistant** (`route.ts`, no extensionId)
- Responds when no specialist is active
- Has a `handoff` tool to route to any enabled specialist
- Knows about the task stack — when a paused task exists, resumes it when the user is done

**Specialist** (e.g. `data-architect/agent.ts`, extensionId set)
- Handles domain-specific work with its own tools and canvas
- Has a `handback` tool with two modes:
  - `pause` — user wants to do something else; saves state, returns to assistant
  - `complete` — user confirmed they're done; pops the task stack

## Flow

### Forward Handoff (Assistant -> Specialist)

1. User sends a message with no `extensionId` set
2. API creates the assistant agent with the `handoff` tool
3. Assistant calls `handoff({ agentId: "data-architect", reason: "..." })`
4. Tool returns `{ handedOffTo: "data-architect", reason: "..." }`
5. Client detects `tool-handoff` part in the streamed response
6. Client sets `extensionId` to the target, marks a pending handoff
7. When the stream finishes, client sends a hidden `[continue]` message
8. API receives `[continue]` with the new `extensionId` and routes to the specialist
9. Specialist responds — the user is now talking to it

### Pause (Specialist -> Assistant)

1. User asks something off-topic while a specialist is active
2. Specialist suggests finishing the current task first
3. If the user insists, specialist calls `handback({ type: "pause", reason: "..." })`
4. Tool returns `{ handoffType: "pause", fromAgent: "data-architect", reason: "..." }`
5. Client detects `tool-handback` part:
   - Pushes `{ extensionId, canvasState, reason, pausedAt }` onto the **task stack**
   - Sets `extensionId` to `null` (assistant)
6. Hidden `[continue]` triggers the assistant
7. Assistant handles the user's side request

### Complete and Resume

When any active agent finishes and the user confirms they're done, the system pops the task stack:

**From a specialist** (most common path):
1. Specialist finishes and asks "anything else?"
2. User confirms they're done
3. Specialist calls `handback({ type: "complete", reason: "..." })`

**From the assistant** (when it handled a side request during a pause):
1. Assistant's prompt knows about the paused task on the stack
2. When the user's side request is resolved, assistant calls `handoff({ agentId: "<paused-specialist>", reason: "resuming" })`

**In both cases, the client handles the stack pop:**
1. Client detects the handoff/handback and checks the task stack
2. If **stack is non-empty** and the target matches the top entry:
   - Pops the stack entry
   - Restores `canvasState` from the entry
   - Sets `resumeContext` (injected into the specialist's instructions)
   - Hidden `[continue]` triggers the resumed specialist
   - Specialist receives `[CONTEXT] User took a detour... Resuming your previous task.`
   - Specialist picks up where it left off with the restored canvas
3. If **stack is empty**: sets `extensionId` to `null`, returns to assistant

## Task Stack

The task stack is an array of `TaskStackEntry` objects, capped at depth 1:

```typescript
interface TaskStackEntry {
  extensionId: string;    // which specialist was paused
  canvasState: unknown;   // snapshot of the canvas at pause time
  reason: string;         // why the user detoured
  pausedAt: string;       // ISO timestamp
}
```

**Depth cap enforcement** (prevents nesting):
- Soft: assistant's prompt says not to hand off when the stack is full
- Hard: `handoff` tool's `execute` returns an error if stack is full (unless it's a resume)
- Client: ignores forward handoffs when the stack is full

**Persistence**: `taskStack` and `activeExtensionId` are persisted as columns on the `conversations` table, surviving page reloads.

## Message Cleaning

When routing to an agent, tool-result parts from other agents are stripped to avoid schema validation errors. For example, when the assistant receives messages after a specialist was active, all `tool-getSkill`, `tool-renderCanvas`, `tool-handback` parts are removed because the assistant doesn't have those tools. Similarly, when a specialist receives messages, the assistant's `tool-handoff` parts are removed.

## Key Files

| File | Purpose |
|------|---------|
| `app/api/chat/route.ts` | API route — builds assistant or specialist agent, message cleaning, depth cap |
| `components/chat/chat-panel.tsx` | Client — handoff detection, task stack push/pop, `[continue]` sender |
| `app/page.tsx` | Page — owns `taskStack` and `activeExtensionId` state |
| `extensions/data-architect/agent.ts` | Data Architect specialist — tools, prompt, `handback` tool |
| `extensions/agents/index.ts` | `getExtensionAgent()` — resolves extensionId to agent instance |
| `lib/types/task-stack.ts` | `TaskStackEntry` type |
| `db/schema.ts` | `taskStack` and `activeExtensionId` columns on conversations table |

## Adding a New Specialist

1. Create `extensions/<name>/agent.ts` with a `ToolLoopAgent` that includes the `handback` tool
2. Create `extensions/<name>/register.ts` calling `registerExtension()`
3. Import the register file in `extensions/index.ts`
4. Add the agent to the `agents` DB table (seed or marketplace)
5. Users enable it via the Marketplace
