import { streamText, gateway, UIMessage, zodSchema } from "ai";
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

  const agent = extensionId ? getExtensionAgent(extensionId) : undefined;

  // For the default assistant, build the prompt from the user's enabled agents
  let systemPrompt = agent?.systemPrompt;
  if (!agent) {
    const enabledAgents = await listEnabledAgents();
    systemPrompt = buildAssistantPrompt(enabledAgents);
  }

  const result = streamText({
    model: gateway(agent?.modelId ?? "anthropic/claude-sonnet-4"),
    system: systemPrompt,
    tools: agent?.tools ?? {
      handoff: {
        description:
          "Hand off the conversation to a specialized agent. Use this when the user's request matches an available agent.",
        inputSchema: zodSchema(
          z.object({
            agentId: z.string().describe("The id of the agent to hand off to"),
            reason: z.string().describe("Brief reason for the handoff"),
          })
        ),
      },
    },
    messages: messages.map((msg) => ({
      role: msg.role,
      content:
        msg.parts
          ?.filter((p): p is { type: "text"; text: string } => p.type === "text")
          .map((p) => p.text)
          .join("\n") ?? "",
    })),
  });

  return result.toUIMessageStreamResponse();
}
