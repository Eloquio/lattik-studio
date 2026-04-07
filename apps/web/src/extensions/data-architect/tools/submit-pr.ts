import { zodSchema } from "ai";
import { z } from "zod";
import type { DefinitionKind } from "@/db/schema";
import {
  createBranch,
  commitFiles,
  createPullRequest,
  getGiteaPRUrl,
} from "@/lib/gitea-client";
import { updateDefinition, getDefinitionByName } from "@/lib/actions/definitions";
import { getCanvasFormState } from "../canvas-to-spec";

interface YamlFile {
  path: string;
  content: string;
}

/**
 * Names that flow into Gitea branch names, commit messages, and PR titles must
 * be tightly constrained — the value originates from canvas form state which is
 * editable by the user *and* shaped by the LLM. A prompt-injected name like
 * `../../evil` or one with embedded newlines would otherwise corrupt the branch
 * path or trick a reviewer reading the commit log.
 *
 * Logger tables use a `schema.table_name` qualified form; everything else is
 * plain snake_case. Both reduce to lowercase letters, digits, underscores and
 * an optional single dot.
 */
const SAFE_NAME_RE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)?$/;
const MAX_NAME_LENGTH = 60;

function isSafeDefinitionName(name: string): boolean {
  return name.length <= MAX_NAME_LENGTH && SAFE_NAME_RE.test(name);
}

/**
 * Allow only YAML files under a single top-level definitions directory and
 * reject path traversal, absolute paths, and any non-`.yaml`/`.yml` extension.
 */
function isSafeYamlPath(path: string): boolean {
  if (path.length === 0 || path.length > 200) return false;
  if (path.startsWith("/") || path.startsWith("\\")) return false;
  if (path.includes("..")) return false;
  if (path.includes("\0") || path.includes("\n") || path.includes("\r")) return false;
  if (!/^[a-zA-Z0-9_./-]+$/.test(path)) return false;
  return /\.ya?ml$/i.test(path);
}

function readYamlFilesFromCanvas(canvasState: unknown): YamlFile[] | null {
  const state = getCanvasFormState(canvasState);
  const raw = state.files;
  if (!Array.isArray(raw)) return null;
  const files: YamlFile[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const path = (item as { path?: unknown }).path;
    const content = (item as { content?: unknown }).content;
    if (
      typeof path === "string" &&
      isSafeYamlPath(path) &&
      typeof content === "string"
    ) {
      files.push({ path, content });
    }
  }
  return files.length > 0 ? files : null;
}

export function createSubmitPRTool(getCanvasState: () => unknown) {
  return {
    description:
      "Submit the YAML files currently displayed in the canvas YAML editor as a PR to Gitea for review. Requires that generateYaml has been called first — reads the (possibly user-edited) YAML files directly from canvas state. The returned `prUrl` is a clickable URL that MUST be shared with the user verbatim.",
    inputSchema: zodSchema(
      z.object({
        kind: z
          .enum(["entity", "dimension", "logger_table", "lattik_table", "metric"])
          .describe("The type of definition currently on the canvas"),
      })
    ),
    execute: async (input: { kind: DefinitionKind }) => {
      const canvasState = getCanvasState();
      const state = getCanvasFormState(canvasState);
      const rawName = typeof state.name === "string" ? state.name : "";
      if (!rawName) {
        return {
          status: "error",
          message:
            "Canvas has no definition name. Run generateYaml first so the YAML editor is populated.",
        };
      }
      // Defense-in-depth: even though forms validate names, the canvas state
      // can be edited by the user *and* mutated by the LLM. We MUST scrub it
      // before interpolating into branch names, commit messages, or PR titles.
      if (!isSafeDefinitionName(rawName)) {
        return {
          status: "error",
          message: `Definition name '${rawName}' is not safe to submit. Names must be snake_case (optionally schema.table_name) and at most ${MAX_NAME_LENGTH} characters.`,
        };
      }
      const name = rawName;

      const files = readYamlFilesFromCanvas(canvasState);
      if (!files) {
        return {
          status: "error",
          message:
            "No YAML files found on the canvas, or one or more YAML file paths failed safety checks. Run generateYaml first to populate the YAML editor before submitting a PR.",
        };
      }

      // Branch names also pass through `name`, so they inherit the same
      // safety guarantee from isSafeDefinitionName above. Replace dots so
      // logger-table qualified names produce a valid git ref.
      const safeBranchName = name.replace(/\./g, "_");
      const branchName = `define/${input.kind}/${safeBranchName}-${Date.now()}`;

      try {
        // Create branch
        await createBranch(branchName);

        // Commit files
        await commitFiles(
          branchName,
          files,
          `Add ${input.kind}: ${name}`
        );

        // Create PR
        const pr = await createPullRequest(
          `Define ${input.kind}: ${name}`,
          `## Definition\n\n**Kind:** ${input.kind}\n**Name:** ${name}\n\nGenerated by Lattik Studio Data Architect.`,
          branchName
        );

        const prUrl = getGiteaPRUrl(pr.number);

        // Update definition status in DB
        const def = await getDefinitionByName(input.kind, name);
        if (def) {
          await updateDefinition(def.id, {
            status: "pending_review",
            prUrl,
          });
        }

        return {
          status: "submitted",
          prNumber: pr.number,
          prUrl,
          branch: branchName,
          files: files.map((f) => f.path),
        };
      } catch (error) {
        console.error("submitPR error:", error);
        return {
          status: "error",
          message: "Failed to submit PR. Please check Gitea is running and try again.",
        };
      }
    },
  };
}
