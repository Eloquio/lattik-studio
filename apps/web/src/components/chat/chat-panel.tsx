"use client";

import { useChat } from "@ai-sdk/react";
import type { UIMessage } from "ai";
import { DefaultChatTransport } from "ai";
import { useEffect, useRef, useState } from "react";
import { ArrowUp, Bot, Pencil, Plus, Trash2 } from "lucide-react";
import Markdown from "react-markdown";
import { buildSpecFromParts } from "@json-render/react";
import { ToolResult } from "./tool-result";
import { ReviewSuggestions } from "./review-suggestions";
import type { ReviewSuggestion } from "@/extensions/data-architect/tools/review-definition";
import { saveConversation, deleteConversation } from "@/lib/actions/conversations";
import type { TaskStackEntry } from "@/lib/types/task-stack";

interface ChatPanelProps {
  chatId: string;
  initialMessages?: UIMessage[];
  savedTitle?: string;
  activeExtensionId: string | null;
  canvasState: unknown;
  onCanvasStateChange: (state: unknown) => void;
  onExtensionChange: (id: string | null) => void;
  onConversationChange?: () => void;
  onNewChat?: () => void;
  taskStack: TaskStackEntry[];
  onTaskStackChange: (stack: TaskStackEntry[]) => void;
  sendMessageRef?: React.MutableRefObject<((text: string) => void) | null>;
  onCanvasStateWrite?: (changes: Array<{ path: string; value: unknown }>) => void;
}

export function ChatPanel({
  chatId,
  initialMessages,
  savedTitle,
  activeExtensionId,
  canvasState,
  onCanvasStateChange,
  onExtensionChange,
  onConversationChange,
  onNewChat,
  taskStack,
  onTaskStackChange,
  sendMessageRef,
  onCanvasStateWrite,
}: ChatPanelProps) {
  const extensionIdRef = useRef(activeExtensionId);
  extensionIdRef.current = activeExtensionId;

  const canvasStateRef = useRef(canvasState);
  canvasStateRef.current = canvasState;

  const taskStackRef = useRef(taskStack);
  taskStackRef.current = taskStack;

  const resumeContextRef = useRef<string | undefined>(undefined);

  const [transport] = useState(
    () =>
      new DefaultChatTransport({
        body: () => ({
          extensionId: extensionIdRef.current,
          canvasState: canvasStateRef.current,
          taskStack: taskStackRef.current,
          resumeContext: resumeContextRef.current,
        }),
      })
  );

  const { messages, sendMessage, status, error } = useChat({
    id: chatId,
    messages: initialMessages,
    transport,
  });
  const [input, setInput] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const isLoading = status === "submitted" || status === "streaming";
  const wasLoadingRef = useRef(false);

  // Expose sendMessage to parent via ref so canvas components can trigger chat messages
  useEffect(() => {
    if (sendMessageRef) {
      sendMessageRef.current = (text: string) => {
        if (!isLoading) sendMessage({ text });
      };
    }
    return () => {
      if (sendMessageRef) sendMessageRef.current = null;
    };
  }, [sendMessage, sendMessageRef, isLoading]);

  // Track which agent owns each assistant message
  const messageAgentMap = useRef<Map<string, string | null>>(new Map());
  useEffect(() => {
    for (const msg of messages) {
      if (msg.role === "assistant" && !messageAgentMap.current.has(msg.id)) {
        messageAgentMap.current.set(msg.id, extensionIdRef.current);
      }
    }
  }, [messages]);

  function getAgentLabel(messageId: string) {
    const agentId = messageAgentMap.current.get(messageId);
    if (agentId === "data-architect") return "Data Architect";
    return "Assistant";
  }

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Auto-save conversation when assistant finishes responding
  useEffect(() => {
    if (wasLoadingRef.current && status === "ready" && messages.length > 0) {
      const firstUserMsg = messages.find((m) => m.role === "user");
      const title = firstUserMsg
        ? firstUserMsg.parts
            .filter((p): p is { type: "text"; text: string } => p.type === "text")
            .map((p) => p.text)
            .join(" ")
            .slice(0, 100) || "New Chat"
        : "New Chat";

      saveConversation({
        id: chatId,
        title,
        messages,
        canvasState: canvasStateRef.current,
        taskStack: taskStackRef.current,
        activeExtensionId: extensionIdRef.current,
      });
      onConversationChange?.();
    }
    wasLoadingRef.current = isLoading;
  }, [status, messages, chatId, isLoading, onConversationChange]);

  // Handle handoff: detect handoff tool, switch agent, wait for stream to finish, then continue
  const handoffProcessedRef = useRef<Set<string>>(new Set());
  const pendingHandoffRef = useRef<boolean>(false);
  const [handoffTrigger, setHandoffTrigger] = useState(0);
  const CONTINUE_MARKER = "[continue]";

  // Detect handoff and mark pending — handles forward (assistant → specialist),
  // pause (specialist → push stack → assistant), and complete (specialist → pop stack)
  useEffect(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role !== "assistant") continue;
      for (const part of msg.parts) {
        if (
          (part.type === "tool-handoff" || part.type === "tool-handback") &&
          "state" in part &&
          "output" in part &&
          part.state === "output-available" &&
          !handoffProcessedRef.current.has(msg.id)
        ) {
          const toolOutput = part.output as Record<string, unknown>;
          handoffProcessedRef.current.add(msg.id);

          // If the server-side tool returned an error (e.g. max task depth
          // reached), do NOT mutate the task stack or active agent. Mark
          // processed and bail so we don't end up in a state where the
          // client thinks we handed off but the server refused.
          if ("error" in toolOutput && typeof toolOutput.error === "string") {
            console.warn("[handoff] server rejected handoff:", toolOutput.error);
            return;
          }

          // CASE 1: Forward handoff (assistant → specialist)
          if ("handedOffTo" in toolOutput && toolOutput.handedOffTo) {
            const targetAgent = toolOutput.handedOffTo as string;
            if (targetAgent !== activeExtensionId) {
              // Check if this is a resume (target matches the paused specialist on the stack)
              const stack = taskStackRef.current;
              if (stack.length > 0 && stack[stack.length - 1].extensionId === targetAgent) {
                // Stack pop: restore canvas state from the paused entry
                const entry = stack[stack.length - 1];
                const newStack = stack.slice(0, -1);
                onTaskStackChange(newStack);
                taskStackRef.current = newStack;

                onCanvasStateChange(entry.canvasState);
                canvasStateRef.current = entry.canvasState;

                const reason = (toolOutput.reason as string) || "a side request";
                resumeContextRef.current =
                  `User took a detour to work on: "${reason}". Resuming your previous task. Pick up where you left off.`;
              }

              pendingHandoffRef.current = true;
              setHandoffTrigger((n) => n + 1);
              extensionIdRef.current = targetAgent;
              onExtensionChange(targetAgent);
            }
            return;
          }

          // CASE 2: Specialist handoff (pause or complete)
          if ("handoffType" in toolOutput) {
            const handoffType = toolOutput.handoffType as "pause" | "complete";
            const fromAgent = toolOutput.fromAgent as string;
            const reason = toolOutput.reason as string;

            if (handoffType === "pause") {
              // Push current state onto stack, return to assistant
              const entry: TaskStackEntry = {
                extensionId: fromAgent,
                canvasState: canvasStateRef.current,
                reason,
                pausedAt: new Date().toISOString(),
              };
              const newStack = [...taskStackRef.current, entry];
              onTaskStackChange(newStack);
              taskStackRef.current = newStack;

              pendingHandoffRef.current = true;
              setHandoffTrigger((n) => n + 1);
              extensionIdRef.current = null;
              onExtensionChange(null);
              resumeContextRef.current = undefined;
              return;
            }

            if (handoffType === "complete") {
              // Pop stack if non-empty, otherwise return to assistant
              if (taskStackRef.current.length > 0) {
                const entry = taskStackRef.current[taskStackRef.current.length - 1];
                const newStack = taskStackRef.current.slice(0, -1);
                onTaskStackChange(newStack);
                taskStackRef.current = newStack;

                // Restore canvas state from the paused task
                onCanvasStateChange(entry.canvasState);
                canvasStateRef.current = entry.canvasState;

                // Inject context for the resumed agent
                resumeContextRef.current =
                  `User took a detour to work on: "${reason}". Resuming your previous task. Pick up where you left off.`;

                pendingHandoffRef.current = true;
              setHandoffTrigger((n) => n + 1);
                extensionIdRef.current = entry.extensionId;
                onExtensionChange(entry.extensionId);
              } else {
                // Stack empty — return to assistant
                pendingHandoffRef.current = true;
              setHandoffTrigger((n) => n + 1);
                extensionIdRef.current = null;
                onExtensionChange(null);
                resumeContextRef.current = undefined;
              }
              return;
            }
          }
        }
      }
    }
  }, [messages, activeExtensionId, onExtensionChange, onCanvasStateChange, onTaskStackChange]);

  // Once stream finishes, send hidden continue message to trigger the new agent.
  // handoffTrigger ensures this re-runs when a handoff is detected, even if
  // status was already "ready" and messages.length didn't change.
  useEffect(() => {
    if (status === "ready" && pendingHandoffRef.current) {
      pendingHandoffRef.current = false;
      sendMessage({ text: CONTINUE_MARKER });
      resumeContextRef.current = undefined;
    }
  }, [status, sendMessage, messages.length, handoffTrigger]);

  // Extract canvas spec from json-render data parts in assistant messages.
  // Spec patches are cumulative across the stream — a later message may emit
  // only state-level patches (e.g. appending a column) that assume structural
  // elements from earlier messages are already present. Calling
  // buildSpecFromParts on a single message starts from an empty spec and
  // would drop those structural elements, blanking the canvas. Collect spec
  // parts from ALL assistant messages so the rebuild is cumulative.
  // Deduplicate: only push to onCanvasStateChange when spec content changes,
  // since buildSpecFromParts returns a new object on every call.
  // Throttled via rAF to prevent cascading re-renders during rapid streaming
  // (each JSONL patch produces a new spec — without throttling this can exceed
  // React's maximum update depth).
  const prevSpecJsonRef = useRef<string>("");
  const pendingSpecRef = useRef<{ spec: unknown; json: string } | null>(null);
  const rafIdRef = useRef<number>(0);
  useEffect(() => {
    const allParts = messages
      .filter((m) => m.role === "assistant")
      .flatMap((m) => m.parts);
    if (allParts.length === 0) return;
    const spec = buildSpecFromParts(allParts);
    if (!spec) return;
    const json = JSON.stringify(spec);
    if (json === prevSpecJsonRef.current) return;
    pendingSpecRef.current = { spec, json };
    if (!rafIdRef.current) {
      rafIdRef.current = requestAnimationFrame(() => {
        rafIdRef.current = 0;
        const pending = pendingSpecRef.current;
        if (pending) {
          pendingSpecRef.current = null;
          prevSpecJsonRef.current = pending.json;
          onCanvasStateChange(pending.spec);
        }
      });
    }
  }, [messages, onCanvasStateChange]);

  // Watch for tool results that return a canvas spec and push it into the
  // canvas. This is the modern path used by the Data Architect agent — instead
  // of free-form generating JSONL spec patches, the agent calls one of the per-
  // kind render tools (renderEntityForm, renderLoggerTableForm, etc.) or
  // generateYaml, and the tool returns a complete server-built spec. The
  // matched tools are:
  //   - tool-render*Form (form rendering)
  //   - tool-generateYaml (YAML editor rendering)
  // This effect must run after the JSONL stream-rebuild effect above so its
  // setCanvasSpec call wins on conflict (in practice there is no conflict —
  // an agent that uses these tools doesn't emit data-spec parts at all).
  const prevRenderFormSpecJsonRef = useRef<string>("");
  useEffect(() => {
    let latestSpec: unknown = null;
    for (const msg of messages) {
      if (msg.role !== "assistant") continue;
      for (const part of msg.parts) {
        const isRenderFormPart =
          part.type.startsWith("tool-render") && part.type.endsWith("Form");
        const isGenerateYamlPart = part.type === "tool-generateYaml";
        if (
          (isRenderFormPart || isGenerateYamlPart) &&
          "state" in part &&
          (part as { state: string }).state === "output-available" &&
          "output" in part
        ) {
          const output = (part as { output?: unknown }).output;
          if (output && typeof output === "object" && "spec" in output) {
            latestSpec = (output as { spec: unknown }).spec;
          }
        }
      }
    }
    if (latestSpec === null) return;
    const json = JSON.stringify(latestSpec);
    if (json === prevRenderFormSpecJsonRef.current) return;
    prevRenderFormSpecJsonRef.current = json;
    onCanvasStateChange(latestSpec);
  }, [messages, onCanvasStateChange]);

  useEffect(() => {
    return () => {
      if (rafIdRef.current) cancelAnimationFrame(rafIdRef.current);
    };
  }, []);

  const handleSubmit = () => {
    if (!input.trim() || isLoading) return;
    sendMessage({ text: input.trim() });
    setInput("");
  };

  const handleDelete = async () => {
    await deleteConversation(chatId);
    onConversationChange?.();
    onNewChat?.();
  };

  const displayTitle = savedTitle || "New Chat";

  return (
    <div className="flex h-full flex-1 flex-col">
      {/* Chat title */}
      <div className="flex shrink-0 items-center justify-between border-b border-white/10 px-5" style={{ height: "49px" }}>
        <div className="flex items-center gap-2">
          <Bot className="h-4 w-4 text-[#e0a96e]" />
          <span className="text-sm font-medium text-white/70">
            {activeExtensionId === "data-architect" ? "Data Architect" : "Lattik Studio Assistant"}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-sm text-white/50 truncate max-w-[200px]">{displayTitle}</span>
          <button className="flex h-7 w-7 items-center justify-center rounded-md text-white/30 transition-colors hover:bg-white/10 hover:text-white/60" title="Edit title">
            <Pencil className="h-3 w-3" />
          </button>
          {messages.length > 0 && (
            <>
              <button
                onClick={onNewChat}
                className="flex h-7 w-7 items-center justify-center rounded-md text-white/30 transition-colors hover:bg-white/10 hover:text-white/60"
                title="New Chat"
              >
                <Plus className="h-3.5 w-3.5" />
              </button>
              <button
                onClick={handleDelete}
                className="flex h-7 w-7 items-center justify-center rounded-md text-white/30 transition-colors hover:bg-white/10 hover:text-red-400"
                title="Delete conversation"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </>
          )}
        </div>
      </div>

      {/* Messages area */}
      <div className="scrollbar-thin flex flex-1 flex-col overflow-y-auto px-6 py-4">
        {messages.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3">
            <h2 className="text-2xl font-bold text-white tracking-tight">
              <span style={{ fontFamily: "var(--font-display), cursive" }}>Lattik<span className="text-[#e0a96e]"> Studio</span></span>
            </h2>
            <p className="text-sm text-white/50">Start a conversation...</p>
          </div>
        ) : (
          <div className="flex w-full flex-col gap-4">
            {messages.map((message) => {
              // Hide the continue marker message
              if (
                message.role === "user" &&
                message.parts.some(
                  (p) => p.type === "text" && "text" in p && p.text === CONTINUE_MARKER
                )
              ) {
                return null;
              }
              return (
              <div
                key={message.id}
                className={`flex ${message.role === "user" ? "justify-end" : "justify-start"}`}
              >
                {message.role === "user" ? (
                  <div className="max-w-[80%] rounded-2xl bg-white/15 px-4 py-2.5 text-sm text-white">
                    {message.parts.map((part, i) =>
                      part.type === "text" ? (
                        <p key={i} className="whitespace-pre-wrap">{part.text}</p>
                      ) : null
                    )}
                  </div>
                ) : (
                  <div className="w-full">
                    <span className="text-xs font-semibold text-[#e0a96e]">
                      {getAgentLabel(message.id)}
                    </span>
                    <div className="mt-1 border-l-2 border-[#e0a96e]/40 pl-4 text-sm text-white/90 prose prose-invert prose-sm max-w-none prose-p:my-1.5 prose-ul:my-1.5 prose-ol:my-1.5 prose-li:my-0.5 prose-headings:text-white prose-strong:text-white prose-code:text-[#e0a96e] prose-code:bg-white/10 prose-code:px-1 prose-code:py-0.5 prose-code:rounded prose-code:text-xs prose-pre:bg-white/5 prose-pre:border prose-pre:border-white/10 prose-a:text-[#e0a96e] prose-a:font-medium prose-a:underline prose-a:decoration-[#e0a96e]/50 prose-a:underline-offset-2 hover:prose-a:text-[#f0bb84] hover:prose-a:decoration-[#e0a96e]">
                      {message.parts.map((part, i) => {
                        if (part.type === "text") {
                          return (
                            <Markdown
                              key={i}
                              skipHtml
                              disallowedElements={["script", "iframe", "object", "embed", "form"]}
                              components={{
                                a: ({ href, children, ...props }) => (
                                  <a
                                    {...props}
                                    href={href}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                  >
                                    {children}
                                  </a>
                                ),
                              }}
                            >
                              {part.text}
                            </Markdown>
                          );
                        }
                        if (part.type.startsWith("tool-") && "state" in part) {
                          const p = part as {
                            state: string;
                            input?: unknown;
                            output?: unknown;
                            rawInput?: unknown;
                            errorText?: string;
                          };
                          const name = part.type.slice(5);
                          // Render review suggestions as interactive cards
                          if (
                            name === "reviewDefinition" &&
                            p.state === "output-available" &&
                            p.output &&
                            typeof p.output === "object" &&
                            "suggestions" in p.output &&
                            Array.isArray((p.output as Record<string, unknown>).suggestions)
                          ) {
                            return (
                              <ReviewSuggestions
                                key={i}
                                suggestions={(p.output as { suggestions: ReviewSuggestion[] }).suggestions}
                                onApply={onCanvasStateWrite}
                                onComplete={(summary) => sendMessage({ text: summary })}
                              />
                            );
                          }
                          return (
                            <ToolResult
                              key={i}
                              toolName={name}
                              state={p.state}
                              input={p.input ?? p.rawInput}
                              output={p.output}
                              errorText={p.errorText}
                            />
                          );
                        }
                        return null;
                      })}
                    </div>
                  </div>
                )}
              </div>
              );
            })}
            {error && (
              <div className="rounded-lg border border-red-500/20 bg-red-500/10 px-4 py-2 text-sm text-red-300">
                {error.message || "Something went wrong. Please try again."}
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>
        )}
      </div>

      {/* Composer */}
      <div className="p-4">
        <div className="relative rounded-2xl border border-white/15 bg-white/10 backdrop-blur-md">
          <textarea
            autoFocus
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Type something..."
            className="w-full resize-none bg-transparent px-4 pt-3 pb-10 text-sm text-white placeholder:text-white/40 focus:outline-none"
            rows={1}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleSubmit();
              }
            }}
          />
          <button
            type="button"
            onClick={() => handleSubmit()}
            disabled={isLoading || !input.trim()}
            className="absolute right-3 bottom-3 flex h-7 w-7 items-center justify-center rounded-lg border border-white/20 bg-white/10 text-white/60 transition-colors hover:bg-white/20 hover:text-white disabled:opacity-30"
          >
            <ArrowUp className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
