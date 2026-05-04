import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { TOOL_DEFINITIONS } from "../workflows/agent-loop.js";

// Minimal JSON Schema shape for our walker — we only touch the fields
// we recurse into. Avoids pulling in `@ai-sdk/provider-utils`'s
// `JSONSchema7` re-export, which isn't a direct dep of agent-service.
interface JsonSchemaProp {
  type?: string | string[];
  enum?: ReadonlyArray<unknown>;
  properties?: Record<string, JsonSchemaProp>;
  required?: string[];
  items?: JsonSchemaProp | JsonSchemaProp[];
  oneOf?: JsonSchemaProp[];
  anyOf?: JsonSchemaProp[];
  allOf?: JsonSchemaProp[];
}

/**
 * Regression catcher for the silent-key-strip class of bug.
 *
 * The AI SDK's `zodSchema()` aggressively rewrites every emitted JSON
 * Schema to set `additionalProperties: false`, even on loose
 * `z.object()` and `z.record()` underlyings. So the JSON Schema view
 * we send the LLM ALWAYS looks strict — but the runtime zod validator
 * still strips unknown keys silently if the underlying schema didn't
 * call `.strict()`. That mismatch is exactly what produced the
 * `columns` vs `user_columns` regression.
 *
 * This test probes runtime behavior. For every tool the LLM sees, it
 * (1) builds a baseline payload that fills all required fields, then
 * (2) appends a sentinel extra key and runs the schema's `validate()`.
 * If validate succeeds, the top-level zod object isn't strict —
 * `strictTool` was bypassed or `.strict()` was dropped, and the
 * silent-strip bug is back. The test fails with a pointer to the
 * offending tool name.
 *
 * Extending: if a tool legitimately needs a permissive top level
 * (e.g. a free-form value pass-through), add the tool name to
 * `ALLOW_LOOSE` with a one-line rationale.
 */

const ALLOW_LOOSE: ReadonlySet<string> = new Set<string>([
  // No exemptions today. When you add one, document the why on the
  // same line — future-you will need to evaluate whether the looseness
  // is still justified when the schema evolves.
]);

const SENTINEL = "__strict_test_sentinel_42_DO_NOT_USE";

function synthesize(schema: JsonSchemaProp): unknown {
  if (schema.enum && schema.enum.length > 0) return schema.enum[0];
  // Discriminated/regular unions: pick the first arm.
  if (schema.anyOf && schema.anyOf.length > 0) return synthesize(schema.anyOf[0]);
  if (schema.oneOf && schema.oneOf.length > 0) return synthesize(schema.oneOf[0]);
  const t = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  switch (t) {
    case "string":
      return "x";
    case "number":
    case "integer":
      return 0;
    case "boolean":
      return true;
    case "array":
      return [];
    case "object": {
      const out: Record<string, unknown> = {};
      const required = schema.required ?? [];
      const props = schema.properties ?? {};
      for (const key of required) {
        const sub = props[key];
        if (sub) out[key] = synthesize(sub);
      }
      return out;
    }
    case "null":
      return null;
    default:
      // No type info (e.g. z.unknown() inside an object) — pass undefined,
      // the caller is expected to handle.
      return undefined;
  }
}

describe("tool input schemas reject unknown keys at runtime", () => {
  for (const [name, factory] of Object.entries(TOOL_DEFINITIONS)) {
    it(`${name}: top-level z.object is .strict() (rejects extra keys)`, async () => {
      if (ALLOW_LOOSE.has(name)) return;

      const tool = factory() as {
        inputSchema: {
          validate?: (v: unknown) => unknown;
          jsonSchema: unknown | PromiseLike<unknown>;
        };
      };
      const validate = tool.inputSchema.validate;
      assert.ok(validate, `Tool "${name}" has no validate() — can't probe`);

      const jsonSchema = (await tool.inputSchema.jsonSchema) as JsonSchemaProp;
      const baseline = synthesize(jsonSchema) as Record<string, unknown>;

      // Sanity: baseline (no sentinel) must validate. If it doesn't, our
      // synthesis is broken for this tool and the strictness probe is
      // inconclusive — fail explicitly instead of letting the next assertion
      // hide the synthesis bug.
      const baselineResult = (await validate(baseline)) as
        | { success: true; value: unknown }
        | { success: false; error: Error };
      assert.equal(
        baselineResult.success,
        true,
        `Tool "${name}" baseline payload didn't validate — synthesize() is missing a case for this schema. Baseline: ${JSON.stringify(baseline)}`,
      );

      // Add the sentinel and re-validate. If the schema is strict, this
      // fails with an unrecognized-keys error. If it's loose (the bug),
      // this succeeds and we either find the sentinel in the parsed value
      // (record-style permissive) or it's silently stripped (default zod).
      const probePayload = { ...baseline, [SENTINEL]: "leaked" };
      const probeResult = (await validate(probePayload)) as
        | { success: true; value: unknown }
        | { success: false; error: Error };

      if (probeResult.success) {
        const passed = (probeResult.value as Record<string, unknown>)[SENTINEL];
        if (passed !== undefined) {
          assert.fail(
            `Tool "${name}" accepted an unknown top-level key without stripping it (record-style permissive). Wrap with strictTool() or constrain the schema.`,
          );
        }
        assert.fail(
          `Tool "${name}" silently stripped an unknown top-level key. The LLM's wrong-key tool calls will succeed with partial input — exactly the silent-strip bug. Wrap with strictTool() or call .strict() on the top-level z.object().`,
        );
      }
    });
  }
});
