# Canvas Rendering

Lattik Studio renders all canvas UI through [json-render](https://github.com/vercel-labs/json-render) (`@json-render/core` + `@json-render/react`). The LLM generates JSON, and json-render renders it safely through a developer-defined component catalog.

## Architecture

```
LLM (Claude Haiku 4.5)
 │
 │  streams text + JSONL patches in ```spec fences
 │
 ▼
pipeJsonRender()              ← transforms stream, extracts patches as data-spec parts
 │
 ▼
useChat / buildSpecFromParts() ← client assembles patches into a Spec
 │
 ▼
<JSONUIProvider>               ← state management (JSON Pointer model)
  <Renderer spec={spec}        ← renders Spec through the component registry
           registry={registry} />
</JSONUIProvider>
```

## Key Files

| File | Purpose |
|------|---------|
| `canvas/catalog.ts` | Component definitions with Zod prop schemas (`defineCatalog`) |
| `canvas/registry.tsx` | Maps catalog components to React implementations (`defineRegistry`) |
| `canvas/data-architect-canvas.tsx` | Wraps `<Renderer>` with `<JSONUIProvider>` |
| `agent.ts` | Injects `catalog.prompt()` into agent instructions |
| `route.ts` | Pipes agent stream through `pipeJsonRender()` |
| `chat-panel.tsx` | Extracts specs from message parts via `buildSpecFromParts()` |
| `use-canvas.ts` | Manages `Spec` state and merges user edits |

## How It Works

### 1. Catalog

The catalog defines what components the LLM can use, with Zod schemas for prop validation:

```ts
import { defineCatalog } from "@json-render/core";
import { schema } from "@json-render/react/schema";

export const catalog = defineCatalog(schema, {
  components: {
    TextInput: {
      props: z.object({
        field: z.string(),
        placeholder: z.string().optional(),
        variant: z.enum(["default", "title", "subtitle"]).optional(),
      }),
      description: "Text input. Reads/writes state at the `field` key.",
    },
    LoggerTableForm: {
      props: z.object({}),
      description: "Logger table definition form. State: name, description, ...",
    },
    // ...15 components total
  },
  actions: {},
});
```

`catalog.prompt({ mode: "inline" })` auto-generates a system prompt that teaches the LLM the available components, their schemas, and the JSONL patch format.

### 2. Registry

Maps catalog component names to actual React implementations:

```ts
import { defineRegistry, useStateStore } from "@json-render/react";

export const { registry } = defineRegistry(catalog, {
  components: {
    TextInput: ({ props }) => {
      const [value, setValue] = useField(props.field);
      return <input value={value} onChange={e => setValue(e.target.value)} />;
    },
    LoggerTableForm: () => {
      const store = useStateStore();
      // reads store.get("/name"), store.get("/retention"), etc.
      // writes store.set("/name", value)
    },
  },
});
```

Components access state via `useStateStore()` (JSON Pointer paths like `/name`, `/user_columns`).

### 3. Server-Side Streaming

The API route pipes the agent stream through `pipeJsonRender()`:

```ts
const stream = await createAgentUIStream({ agent, uiMessages });
return createUIMessageStreamResponse({
  stream: pipeJsonRender(stream),
});
```

`pipeJsonRender()` intercepts JSONL lines inside `` ```spec `` fences and re-emits them as `data-spec` typed data parts. Regular text passes through as prose.

### 4. Client-Side Rendering

The chat panel extracts specs from message parts:

```ts
import { buildSpecFromParts } from "@json-render/react";

const spec = buildSpecFromParts(message.parts);
// spec = { root: "form", elements: { form: { type: "LoggerTableForm", ... } }, state: { ... } }
```

The canvas renders it:

```tsx
<JSONUIProvider registry={registry} initialState={spec.state ?? {}}>
  <Renderer spec={spec} registry={registry} />
</JSONUIProvider>
```

### 5. LLM Output Format

The LLM streams JSONL patches (RFC 6902) inside a fenced block:

````
Let me set up the logger table form for you.

```spec
{"op":"add","path":"/root","value":"form"}
{"op":"add","path":"/elements/form","value":{"type":"LoggerTableForm","props":{}}}
{"op":"add","path":"/state","value":{"name":"ingest.click_events","retention":"30d","dedup_window":"1h","user_columns":[]}}
```
````

Each line is a JSON Patch operation that incrementally builds the Spec.

## State Management

All canvas state lives in the json-render state model — a flat key-value store accessed via JSON Pointer paths.

- **Read:** `store.get("/name")` or `useStateValue("/name")`
- **Write:** `store.set("/name", value)`
- **Two-way binding:** `{ "$bindState": "/name" }` in element props

### State Persistence

State survives page refresh through this flow:

1. LLM streams patches → `buildSpecFromParts()` assembles a `Spec`
2. User edits the form → `JSONUIProvider.onStateChange` fires → `mergeStateChanges()` updates the `Spec.state`
3. `saveConversation()` persists the full `Spec` (including `state`) to PostgreSQL as JSONB
4. On page load → `getConversation()` restores the `Spec` → passed to `<Renderer>` → form re-renders with saved values

### readCanvasState Tool

The agent can read current form values via the `readCanvasState` tool. It returns the `Spec.state` object so the agent can see what the user has filled in.

## Components

### Layout
- **Section** — vertical container with optional title
- **Heading** — title + optional subtitle

### Form Fields
- **TextInput** — text input with variants (`default`, `title`, `subtitle`)
- **Select** — dropdown select
- **Checkbox** — boolean toggle

### Data Display
- **DataTable** — read-only table with columns and rows
- **MockedTablePreview** — table preview with auto-generated mock data

### Domain-Specific
- **ColumnList** — editable column list (name + type)
- **ReviewCard** — accept/deny card for AI suggestions
- **StatusBadge** — pipeline status indicator

### Composite Forms
These render complete definition forms. All data lives in `Spec.state`:

- **LoggerTableForm** — state: `name`, `description`, `retention`, `dedup_window`, `user_columns[]`
- **EntityForm** — state: `name`, `description`, `id_field`, `id_type`
- **DimensionForm** — state: `name`, `description`, `entity`, `source_table`, `source_column`, `data_type`
- **MetricForm** — state: `name`, `description`, `calculations[]`
- **LattikTableForm** — state: `name`, `description`, `primary_key[]`, `column_families[]`, `derived_columns[]`

## Canvas → Chat Communication

Canvas components can send messages to the chat panel (as if the user typed them) via `CanvasActionsContext`. This is useful for buttons like "Review Table" that trigger agent workflows from the canvas.

### Data Flow

```
LoggerTableForm (registry.tsx)
  → useCanvasActions().sendChatMessage("Review table")
  → CanvasActionsContext (provided by DataArchitectCanvas)
  → onSendMessage prop (threaded: DataArchitectCanvas ← CanvasPanel ← page.tsx)
  → sendMessageRef (ChatPanel exposes sendMessage via a mutable ref)
  → useChat().sendMessage({ text })
```

### Key Files

| File | Role |
|------|------|
| `components/canvas/canvas-actions-context.tsx` | Context definition + `useCanvasActions()` hook |
| `extensions/.../canvas/data-architect-canvas.tsx` | Provides context with `onSendMessage` |
| `components/canvas/canvas-panel.tsx` | Threads `onSendMessage` to the canvas component |
| `components/chat/chat-panel.tsx` | Exposes `sendMessage` via `sendMessageRef` prop |
| `app/page.tsx` | Wires the ref from ChatPanel to CanvasPanel |

### Usage in Registry Components

```tsx
import { useCanvasActions } from "@/components/canvas/canvas-actions-context";

// Inside a registry component:
const { sendChatMessage } = useCanvasActions();
// ...
<button onClick={() => sendChatMessage("Review table")}>Review Table</button>
```

### Adding to a New Extension

1. Accept `onSendMessage` in your canvas component props
2. Wrap your `<JSONUIProvider>` with `<CanvasActionsContext value={...}>`
3. Call `useCanvasActions()` in any registry component that needs it

## Adding a New Component

1. Add the component definition to `catalog.ts` with Zod prop schema
2. Add the React implementation to `registry.tsx`
3. The LLM automatically discovers it via `catalog.prompt()`
