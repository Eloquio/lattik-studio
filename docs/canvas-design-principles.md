# Canvas Design Principles

Design guidelines for canvas forms and UI components in Lattik Studio.

## Color System

Use a two-tone color system to create contrast and hierarchy:

- **`stone-*`** (warm gray) for all structural elements — text, borders, table headers, labels, separators, placeholders. This provides clear contrast against the light canvas background.
- **`amber-*`** reserved for **accent only** — focus rings, hover states on interactive elements, active highlights, and branding. Amber stands out because it's not used everywhere.
- Avoid monochrome amber-on-amber — it creates a muddy, low-contrast wash.

## Form Fields

### Inline Text Inputs

Prefer borderless, label-free inline inputs that look like static text until focused:

```
- No border, no background, no box
- Placeholder text serves as the label
- Text styling differentiates field purpose (size, weight, font)
```

Example hierarchy for a definition form:
- **Name**: `text-sm font-semibold font-mono` — large, bold, monospace
- **Type**: `text-xs uppercase` — small, uppercase when filled, regular case for placeholder
- **Description**: `text-xs text-stone-500` — small, muted
- **Metadata fields**: `text-xs text-stone-600` — small, slightly darker

### When to Use Boxed Inputs

Use bordered inputs (`inputCls`) only in:
- Standalone labeled form fields (e.g. Retention, Dedup Window)
- Generic reusable components (`TextInput`, `Select`)

## Popup Dialogs

### Structure

```
┌─ Header (amber-50 bg, border-b) ──────────────┐
│  Title                                    ✕    │
├────────────────────────────────────────────────│
│                                                │
│  Inline fields (no labels, no boxes)           │
│                                                │
├─ Actions (border-t) ──────────────────────────│
│                              Cancel    [Add]   │
└────────────────────────────────────────────────┘
```

- **Header**: subtle amber background with title and close button
- **Body**: inline fields with consistent placeholder hints, no labels
- **Footer**: right-aligned actions separated by a thin border
- **Backdrop**: `bg-black/10 backdrop-blur-[1px]`, positioned within the canvas (not the full viewport)
- **Shape**: `rounded-xl`, no `overflow-hidden` (dropdowns must not be clipped)

### Placeholder Hints

Use sentence case, short descriptive phrases:
- `new_column_name` (code-style for identifiers)
- `What's the data type of this column?`
- `Describe the column`
- `Bind to dimension if applicable`

### Keyboard Interaction

- **Enter** submits the form
- **Escape** closes the dialog
- Autocomplete dropdowns must `stopPropagation` on Enter to prevent form submission while selecting

## Tag Pills

Use rounded pills (`rounded-full`) for toggleable tags and metadata badges:

- **Toggle pill** (e.g. PII): `bg-stone-100 text-stone-400` when off, colored when on (e.g. `bg-red-100 text-red-600 ring-1 ring-red-200`)
- **Info badge** (e.g. dimension name): `bg-blue-100 text-blue-600`
- Keep pills compact: `px-2 py-0.5 text-[10px]`

## Tables

### Column Lists

- **System columns**: `bg-stone-50/50` background, muted text, lock icon with tooltip
- **User columns**: white background, full contrast text, hover to reveal delete
- **Section labels**: `text-[10px] uppercase tracking-wider text-stone-400` (e.g. "Custom columns", "Partition columns")
- **Add button**: full-width dashed border, centered text, amber hover accent
- **Empty state**: centered italic text (e.g. "No custom columns yet")

### Preview Tables

- Show mock data that is **deterministic** (no `Date.now()` or `Math.random()`)
- Column hover in the columns list highlights the corresponding column in preview (`bg-amber-50/100`)
- Hover state is ephemeral UI — use React `useState`, not json-render state

### Data Types in Tables

Display data types in **uppercase** (`STRING`, `INT32`, `TIMESTAMP`). Store lowercase internally for compatibility with `lattik-expression`.

## Autocomplete (Combobox)

- Free-form text input with dropdown suggestions
- Arrow keys navigate, Enter selects, Escape closes
- Validate input with `fromColumnType()` from `@eloquio/lattik-expression`
- Invalid input: red text (not red border on borderless inputs)
- Active item: `bg-stone-100 text-amber-700 font-medium`
- Dropdown: `rounded-md border border-stone-200 bg-white shadow-lg`

## State Management

- **Form data** (name, description, columns, etc.): managed by json-render's `useStateStore()` — persists across page refresh
- **Ephemeral UI state** (hover, popup open, edit mode): React `useState` — does not persist
- **Mock data**: must be deterministic — use constant arrays, not runtime-generated values

## Composite Form Components

Each composite form (e.g. `LoggerTableForm`, `EntityForm`) renders its own title. The LLM agent should **never** add a separate `Heading` component before a composite form. This is enforced by:
1. Component catalog descriptions stating "never pair with a Heading"
2. The `Heading` component rendering `null` in the registry
