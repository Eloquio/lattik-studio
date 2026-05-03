import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extensionIdToAgentId, agentIdToExtensionId } from "./agent-id";

describe("extensionIdToAgentId", () => {
  it("maps the three kebab-case specialists", () => {
    assert.equal(extensionIdToAgentId("pipeline-manager"), "PipelineManager");
    assert.equal(extensionIdToAgentId("data-architect"), "DataArchitect");
    assert.equal(extensionIdToAgentId("data-analyst"), "DataAnalyst");
  });

  it("treats null as the Assistant concierge", () => {
    assert.equal(extensionIdToAgentId(null), "Assistant");
  });

  it("falls back to Assistant for unknown ids — defensive default", () => {
    assert.equal(extensionIdToAgentId("not-a-real-agent"), "Assistant");
  });
});

describe("agentIdToExtensionId", () => {
  it("maps the three PascalCase specialists back to kebab-case", () => {
    // This is the normalization the handoff tool's output goes through —
    // forgetting it was the cutover bug that broke the canvas registry
    // lookup (canvases.ts is keyed kebab-case).
    assert.equal(agentIdToExtensionId("PipelineManager"), "pipeline-manager");
    assert.equal(agentIdToExtensionId("DataArchitect"), "data-architect");
    assert.equal(agentIdToExtensionId("DataAnalyst"), "data-analyst");
  });

  it("passes unknown agent ids through unchanged", () => {
    // Future-proofing: a new specialist shipped without the chat-panel
    // being updated should at least not silently turn into "" or
    // something that looks like a different known agent.
    assert.equal(agentIdToExtensionId("FuturisticAgent"), "FuturisticAgent");
  });
});

describe("round-trip", () => {
  it("extensionId → agentId → extensionId is identity for known specialists", () => {
    for (const ext of ["pipeline-manager", "data-architect", "data-analyst"]) {
      const back = agentIdToExtensionId(extensionIdToAgentId(ext));
      assert.equal(back, ext, `round-trip mismatch for ${ext}`);
    }
  });
});
