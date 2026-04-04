# Defining a New Entity

## Overview
An Entity is a business concept that uniquely identifies something in the system — like a user, a game, or a session. Entities serve as join keys across Logger Tables and Lattik Tables.

## Fields
- **name** (string, required) — snake_case identifier, e.g. `user`, `game`, `session`
- **description** (string, required) — what this entity represents in the business domain
- **id_field** (string, required) — the column name used to identify this entity, e.g. `user_id`, `game_id`
- **id_type** (enum, required) — data type of the ID field: `int64` or `string`

## Workflow (7 steps)

### Step 1 of 7: Gather Requirements
> Status: draft

Ask the user what business concept they want to define. Understand:
- What does this entity represent?
- How is it identified (what ID field)?
- What is the ID data type?

### Step 2 of 7: Render Draft on Canvas
> Status: draft

Use `renderCanvas` to show the entity definition form on the canvas with the fields populated from the conversation. Include a StatusBadge at the top showing "draft" status.

### Step 3 of 7: Collaborate on Definition
> Status: draft

The user may edit fields directly on the canvas or ask for changes via chat. Use `readCanvasState` to check their edits. Update the canvas as needed.

### Step 4 of 7: AI Review
> Status: reviewing

When the user asks to review, use `reviewDefinition` and analyze the definition. Provide suggestions:
- Is the name clear and follows naming conventions?
- Is the description meaningful?
- Is the ID type appropriate for the use case?
Render suggestions as ReviewCard components on the canvas.

### Step 5 of 7: Accept/Deny Suggestions
> Status: reviewing

Wait for the user to accept or deny each suggestion via the canvas. Use `readCanvasState` to check decisions. Apply accepted changes.

### Step 6 of 7: Static Checks
> Status: checks-passed or checks-failed

Run `staticCheck` to validate:
- Name is snake_case, 1-60 characters, no reserved words
- Description is 10-500 characters
- ID field name ends with `_id`
- ID type is `int64` or `string`

### Step 7 of 7: Generate and Submit
> Status: pr-submitted

Use `updateDefinition` to save the final draft, then `submitPR` to generate YAML and create a PR.

## Validation Rules
- Entity name must be snake_case, 1-60 chars
- Entity name must not conflict with existing entities
- Description required, 10-500 chars
- ID field must end with `_id`
- ID type must be `int64` or `string`

## Example
```yaml
name: user
description: A registered user of the platform
id_field: user_id
id_type: int64
```
