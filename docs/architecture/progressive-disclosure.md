# Progressive Disclosure for Agents

## Principle

Agent instructions stay high-level. Detailed workflows are only loaded on-demand when the user asks for something specific.

This keeps the agent's system prompt small, reduces noise, and ensures the agent always follows the latest version of a skill document rather than relying on baked-in instructions.

## What lives where

### Agent instructions (always loaded)

- Identity and role
- List of available skills (names and one-line descriptions only)
- Instruction to call `getSkill` before starting any workflow
- General behavioral guidelines
- Handoff protocol (off-topic, task completion)

### Skill documents (loaded on-demand via `getSkill`)

- Full workflow steps
- Canvas layout and component usage
- Field definitions and validation rules
- Update workflows and immutability constraints
- Domain-specific rules (e.g., referential integrity)

## Flow

```
User: "I want to do X"
  |
  v
Agent matches the request to a skill
  |
  v
Agent calls getSkill("skill-name")
  |
  v
Skill document is loaded into context with full workflow
  |
  v
Agent follows the steps in the skill document
```

## Why

1. **Smaller system prompt** -- the agent doesn't carry every workflow in its instructions, leaving more context for the actual conversation.
2. **Single source of truth** -- workflow details live in one place (the skill file). No risk of the agent instructions and skill documents contradicting each other.
3. **Easier to maintain** -- updating a workflow means editing one skill file, not also updating the agent instructions.
4. **Scales with complexity** -- adding a new skill means adding a new skill file without bloating the base prompt.
