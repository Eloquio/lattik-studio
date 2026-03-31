import { streamText, gateway, UIMessage } from "ai";

export async function POST(req: Request) {
  const { messages }: { messages: UIMessage[] } = await req.json();

  const result = streamText({
    model: gateway("anthropic/claude-sonnet-4"),
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
