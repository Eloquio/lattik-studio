import {
  streamText,
  gateway,
  UIMessage,
  zodSchema,
  createAgentUIStreamResponse,
  createAgentUIStream,
  createUIMessageStreamResponse,
  ToolLoopAgent,
  stepCountIs,
} from "ai";
import { z } from "zod";
import { pipeJsonRender } from "@json-render/core";
import { getExtensionAgent } from "@/extensions/agents";
import { getExtension } from "@/extensions/registry";
import { listEnabledAgents } from "@/lib/actions/agents";
import { rateLimit } from "@/lib/rate-limit";
import "@/extensions";

/** Max request body size: 2MB */
const MAX_BODY_SIZE = 2 * 1024 * 1024;
/** Max messages per request */
const MAX_MESSAGES = 200;

function buildAssistantPrompt(
  agents: { id: string; name: string; description: string }[],
  currentTaskStack?: { extensionId: string; reason: string }[]
) {
  const agentList =
    agents.length > 0
      ? agents.map((a) => `- **${a.name}** (id: "${a.id}"): ${a.description}`).join("\n")
      : "No agents enabled. Suggest the user visit the Agent Marketplace to enable specialized agents.";

  const stackNote =
    currentTaskStack && currentTaskStack.length > 0
      ? `\n\n## Paused Task\nThere is a paused task on the stack: the "${currentTaskStack[0].extensionId}" agent was working on "${currentTaskStack[0].reason}" and is waiting to resume.\n- Do NOT hand off to a different specialist — handle the user's new request yourself.\n- When the user indicates they are done with their current request ("that's all", "nothing else", "I'm done", etc.), use the handoff tool to resume the paused agent (agentId: "${currentTaskStack[0].extensionId}") so it can continue where it left off.\n- Briefly tell the user you're handing them back to the paused agent.`
      : "";

  return `You are the Lattik Studio Assistant — the main AI assistant for Lattik Studio, an agentic analytics platform.

You help users with their analytics needs. When a user's request matches a specialized agent, hand off to that agent using the handoff tool.

Available agents:
${agentList}

## When to hand off
- If the user's request clearly matches an available agent's specialty → hand off
- For general questions, greetings, or tasks that don't match any agent → handle them yourself
- If no agents are enabled, let the user know they can enable agents in the Marketplace

## Guidelines
- Be friendly and concise
- When handing off, briefly tell the user which agent you're routing them to and why${stackNote}`;
}

/**
 * Strip tool parts that don't belong to the target agent and remove empty
 * text parts so the Anthropic API never receives `{type:"text", text:""}`.
 * Messages left with no parts are dropped entirely.
 */
function cleanUIMessages(
  messages: UIMessage[],
  agentTools: Record<string, unknown>
): UIMessage[] {
  return messages
    .map((msg) => ({
      ...msg,
      parts: (msg.parts ?? []).filter((part) => {
        // Drop tool parts that aren't in the target agent's tool set
        if (part.type.startsWith("tool-") && "toolCallId" in part) {
          const toolName = part.type.slice(5);
          return toolName in agentTools;
        }
        // Drop empty text parts
        if (part.type === "text" && "text" in part && (part as { text: string }).text === "") {
          return false;
        }
        return true;
      }),
    }))
    .filter((msg) => msg.parts.length > 0);
}

export async function POST(req: Request) {
  // Auth check
  const { auth } = await import("@/auth");
  const session = await auth();
  if (!session?.user) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Rate limiting (30 requests per minute per user)
  const userId = session.user.id ?? session.user.email ?? "unknown";
  const { allowed, remaining } = rateLimit(`chat:${userId}`, { maxRequests: 30, windowMs: 60_000 });
  if (!allowed) {
    return Response.json(
      { error: "Too many requests. Please wait before sending another message." },
      { status: 429, headers: { "X-RateLimit-Remaining": String(remaining) } }
    );
  }

  // Body size check via Content-Length (best effort — streaming bodies may not have it)
  const contentLength = req.headers.get("content-length");
  if (contentLength && parseInt(contentLength, 10) > MAX_BODY_SIZE) {
    return Response.json({ error: "Request too large" }, { status: 413 });
  }

  let body: {
    messages?: unknown;
    extensionId?: unknown;
    canvasState?: unknown;
    taskStack?: unknown;
    resumeContext?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { messages, extensionId, canvasState, taskStack, resumeContext } = body as {
    messages: UIMessage[];
    extensionId?: string;
    canvasState?: unknown;
    taskStack?: { extensionId: string; canvasState: unknown; reason: string; pausedAt: string }[];
    resumeContext?: string;
  };

  if (!Array.isArray(messages)) {
    return Response.json({ error: "messages must be an array" }, { status: 400 });
  }

  if (messages.length > MAX_MESSAGES) {
    return Response.json({ error: `Too many messages (max ${MAX_MESSAGES})` }, { status: 400 });
  }

  // Validate extensionId if provided
  if (extensionId && typeof extensionId === "string" && !getExtension(extensionId)) {
    return Response.json({ error: "Unknown extension" }, { status: 400 });
  }

  // Use the extension's ToolLoopAgent if available
  const agent = extensionId && typeof extensionId === "string"
    ? getExtensionAgent(extensionId, { canvasState, taskStack, resumeContext })
    : undefined;

  if (agent) {
    const cleanMessages = cleanUIMessages(messages, agent.tools ?? {});

    const stream = await createAgentUIStream({
      agent,
      uiMessages: cleanMessages,
    });
    return createUIMessageStreamResponse({
      stream: pipeJsonRender(stream),
    });
  }

  // Default assistant with handoff
  const enabledAgents = await listEnabledAgents();
  const assistantAgent = new ToolLoopAgent({
    model: gateway("anthropic/claude-haiku-4.5"),
    instructions: buildAssistantPrompt(enabledAgents, taskStack),
    tools: {
      handoff: {
        description:
          "Hand off the conversation to a specialized agent. Use this when the user's request matches an available agent.",
        inputSchema: zodSchema(
          z.object({
            agentId: z.string().describe("The id of the agent to hand off to"),
            reason: z.string().describe("Brief reason for the handoff"),
          })
        ),
        execute: async (input: { agentId: string; reason: string }) => {
          // Allow resuming the paused specialist (stack pop), but block new handoffs
          const isPausedResume = taskStack && taskStack.length > 0
            && taskStack[taskStack.length - 1].extensionId === input.agentId;
          if (taskStack && taskStack.length >= 1 && !isPausedResume) {
            return {
              error: "Maximum task depth reached. Handle this request directly or suggest the user finish their paused task.",
            };
          }
          return { handedOffTo: input.agentId, reason: input.reason };
        },
      },
    },
    stopWhen: stepCountIs(5),
  });

  const cleanAssistantMessages = cleanUIMessages(messages, assistantAgent.tools ?? {});

  return createAgentUIStreamResponse({
    agent: assistantAgent,
    uiMessages: cleanAssistantMessages,
  });
}
