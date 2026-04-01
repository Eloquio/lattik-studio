import { streamText, gateway, UIMessage, zodSchema } from "ai";
import { z } from "zod";
import { getExtensionAgent } from "@/extensions/agents";
import { getAllExtensions } from "@/extensions/registry";
import "@/extensions";

const assistantSystemPrompt = `You are the Lattik Studio Assistant — the main AI assistant for Lattik Studio, an agentic analytics platform.

You help users with their analytics needs. When a user's request matches a specialized agent, hand off to that agent using the handoff tool.

Available agents:
${getAllExtensions()
  .map((ext) => `- **${ext.name}** (id: "${ext.id}"): ${ext.description}`)
  .join("\n")}

## When to hand off
- If the user wants to design pipelines, create tables, define entities, or work on data architecture → hand off to "data-architect"
- For general questions, greetings, or tasks that don't match any agent → handle them yourself

## Guidelines
- Be friendly and concise
- When handing off, briefly tell the user which agent you're routing them to and why`;

export async function POST(req: Request) {
  const { messages, extensionId }: { messages: UIMessage[]; extensionId?: string } =
    await req.json();

  const agent = extensionId ? getExtensionAgent(extensionId) : undefined;

  const result = streamText({
    model: gateway(agent?.modelId ?? "anthropic/claude-sonnet-4"),
    system: agent?.systemPrompt ?? assistantSystemPrompt,
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
