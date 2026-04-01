import {
  streamText,
  gateway,
  UIMessage,
  zodSchema,
  createAgentUIStreamResponse,
  ToolLoopAgent,
  stepCountIs,
} from "ai";
import { z } from "zod";
import { getExtensionAgent } from "@/extensions/agents";
import { listEnabledAgents } from "@/lib/actions/agents";
import "@/extensions";

function buildAssistantPrompt(
  agents: { id: string; name: string; description: string }[]
) {
  const agentList =
    agents.length > 0
      ? agents.map((a) => `- **${a.name}** (id: "${a.id}"): ${a.description}`).join("\n")
      : "No agents enabled. Suggest the user visit the Agent Marketplace to enable specialized agents.";

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
- When handing off, briefly tell the user which agent you're routing them to and why`;
}

export async function POST(req: Request) {
  const { messages, extensionId }: { messages: UIMessage[]; extensionId?: string } =
    await req.json();

  // Use the extension's ToolLoopAgent if available
  const agent = extensionId ? getExtensionAgent(extensionId) : undefined;

  if (agent) {
    // Strip tool parts from other agents (e.g. handoff) to avoid schema validation errors
    const cleanMessages = messages.map((msg) => ({
      ...msg,
      parts: msg.parts.filter((part) => {
        if (part.type.startsWith("tool-") && "toolCallId" in part) {
          const toolName = part.type.slice(5);
          return toolName in (agent.tools ?? {});
        }
        return true;
      }),
    }));

    return createAgentUIStreamResponse({
      agent,
      uiMessages: cleanMessages,
    });
  }

  // Default assistant with handoff
  const enabledAgents = await listEnabledAgents();
  const assistantAgent = new ToolLoopAgent({
    model: gateway("anthropic/claude-sonnet-4"),
    instructions: buildAssistantPrompt(enabledAgents),
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
        execute: async (input: { agentId: string; reason: string }) => ({
          handedOffTo: input.agentId,
          reason: input.reason,
        }),
      },
    },
    stopWhen: stepCountIs(5),
  });

  return createAgentUIStreamResponse({
    agent: assistantAgent,
    uiMessages: messages,
  });
}
