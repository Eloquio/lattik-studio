import { getInstallationToken } from "./github-app-auth";

const GITHUB_API = "https://api.github.com";
const GITHUB_OWNER = process.env.GITHUB_OWNER ?? "";
const GITHUB_REPO = process.env.GITHUB_REPO ?? "";

function ensureConfig() {
  if (!GITHUB_OWNER || !GITHUB_REPO) {
    throw new Error(
      "GITHUB_OWNER and GITHUB_REPO environment variables must be set.",
    );
  }
  // Token-side env (GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY,
  // GITHUB_APP_INSTALLATION_ID) is validated lazily inside
  // getInstallationToken so a misconfigured installation surfaces a
  // specific, actionable error message on the first API call.
}

function repoUrl(suffix: string): string {
  return `${GITHUB_API}/repos/${GITHUB_OWNER}/${GITHUB_REPO}${suffix}`;
}

async function ghFetch(url: string, init?: RequestInit): Promise<Response> {
  const token = await getInstallationToken();
  return fetch(url, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      Authorization: `Bearer ${token}`,
      ...(init?.headers ?? {}),
    },
  });
}

export async function createBranch(branchName: string, fromRef = "main") {
  ensureConfig();
  // GitHub's git refs API needs the SHA of the source ref to branch from.
  const baseRefRes = await ghFetch(repoUrl(`/git/ref/heads/${encodeURIComponent(fromRef)}`));
  if (!baseRefRes.ok) {
    throw new Error(
      `Failed to read base ref 'heads/${fromRef}': ${baseRefRes.status} ${await baseRefRes.text()}`,
    );
  }
  const baseRef = await baseRefRes.json();
  const baseSha: string = baseRef.object.sha;

  const res = await ghFetch(repoUrl("/git/refs"), {
    method: "POST",
    body: JSON.stringify({
      ref: `refs/heads/${branchName}`,
      sha: baseSha,
    }),
  });
  if (res.status === 422) {
    // Already exists — safe to continue
    return { name: branchName, existing: true };
  }
  if (!res.ok) {
    throw new Error(
      `Failed to create branch '${branchName}': ${res.status} ${await res.text()}`,
    );
  }
  return res.json();
}

/**
 * Atomic multi-file commit via the Git Data API. We create blobs for each
 * file, assemble them into a new tree on top of the branch's current tree,
 * and create one commit pointing at that tree. This matches Gitea's batch
 * commit semantics — N files become 1 commit, not N — and avoids the
 * ugly per-file commit history you'd get from the Contents API.
 */
export async function commitFiles(
  branchName: string,
  files: { path: string; content: string }[],
  message: string,
) {
  ensureConfig();
  if (files.length === 0) {
    throw new Error("commitFiles called with no files");
  }

  // 1. Get the branch's current commit SHA + tree SHA.
  const refRes = await ghFetch(repoUrl(`/git/ref/heads/${encodeURIComponent(branchName)}`));
  if (!refRes.ok) {
    throw new Error(
      `Failed to read ref 'heads/${branchName}': ${refRes.status} ${await refRes.text()}`,
    );
  }
  const ref = await refRes.json();
  const parentSha: string = ref.object.sha;

  const commitRes = await ghFetch(repoUrl(`/git/commits/${parentSha}`));
  if (!commitRes.ok) {
    throw new Error(
      `Failed to read commit ${parentSha}: ${commitRes.status} ${await commitRes.text()}`,
    );
  }
  const parentCommit = await commitRes.json();
  const baseTreeSha: string = parentCommit.tree.sha;

  // 2. Upload each file as a blob (base64).
  const blobShas = await Promise.all(
    files.map(async (f) => {
      const blobRes = await ghFetch(repoUrl("/git/blobs"), {
        method: "POST",
        body: JSON.stringify({
          content: Buffer.from(f.content).toString("base64"),
          encoding: "base64",
        }),
      });
      if (!blobRes.ok) {
        throw new Error(
          `Failed to create blob for '${f.path}': ${blobRes.status} ${await blobRes.text()}`,
        );
      }
      const blob = await blobRes.json();
      return { path: f.path, sha: blob.sha as string };
    }),
  );

  // 3. Create a new tree on top of the parent tree.
  const treeRes = await ghFetch(repoUrl("/git/trees"), {
    method: "POST",
    body: JSON.stringify({
      base_tree: baseTreeSha,
      tree: blobShas.map((b) => ({
        path: b.path,
        mode: "100644",
        type: "blob",
        sha: b.sha,
      })),
    }),
  });
  if (!treeRes.ok) {
    throw new Error(
      `Failed to create tree: ${treeRes.status} ${await treeRes.text()}`,
    );
  }
  const tree = await treeRes.json();

  // 4. Create the commit object.
  const newCommitRes = await ghFetch(repoUrl("/git/commits"), {
    method: "POST",
    body: JSON.stringify({
      message,
      tree: tree.sha,
      parents: [parentSha],
    }),
  });
  if (!newCommitRes.ok) {
    throw new Error(
      `Failed to create commit: ${newCommitRes.status} ${await newCommitRes.text()}`,
    );
  }
  const newCommit = await newCommitRes.json();

  // 5. Advance the branch ref to the new commit.
  const updateRes = await ghFetch(
    repoUrl(`/git/refs/heads/${encodeURIComponent(branchName)}`),
    {
      method: "PATCH",
      body: JSON.stringify({ sha: newCommit.sha, force: false }),
    },
  );
  if (!updateRes.ok) {
    throw new Error(
      `Failed to advance branch '${branchName}' to ${newCommit.sha}: ${updateRes.status} ${await updateRes.text()}`,
    );
  }
  return newCommit;
}

export async function deleteFile(
  branchName: string,
  path: string,
  message: string,
) {
  ensureConfig();
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");

  // GitHub's Contents API requires the file's current blob SHA to delete it.
  const existingRes = await ghFetch(
    repoUrl(
      `/contents/${encodedPath}?ref=${encodeURIComponent(branchName)}`,
    ),
  );
  if (existingRes.status === 404) {
    throw new Error(
      `File '${path}' does not exist on branch '${branchName}' — nothing to delete.`,
    );
  }
  if (!existingRes.ok) {
    throw new Error(
      `Failed to locate file '${path}' on branch '${branchName}': ${existingRes.status} ${await existingRes.text()}`,
    );
  }
  const existing = await existingRes.json();

  const res = await ghFetch(repoUrl(`/contents/${encodedPath}`), {
    method: "DELETE",
    body: JSON.stringify({
      branch: branchName,
      message,
      sha: existing.sha,
    }),
  });
  if (!res.ok) {
    throw new Error(
      `Failed to delete file '${path}' on branch '${branchName}': ${res.status} ${await res.text()}`,
    );
  }
  return res.json();
}

export async function createPullRequest(
  title: string,
  body: string,
  headBranch: string,
  baseBranch = "main",
) {
  ensureConfig();
  const res = await ghFetch(repoUrl("/pulls"), {
    method: "POST",
    body: JSON.stringify({
      title,
      body,
      head: headBranch,
      base: baseBranch,
    }),
  });
  if (!res.ok) {
    throw new Error(`Failed to create PR: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

export async function getPullRequest(prNumber: number) {
  ensureConfig();
  const res = await ghFetch(repoUrl(`/pulls/${prNumber}`));
  if (!res.ok) {
    throw new Error(`Failed to get PR: ${res.status}`);
  }
  return res.json();
}

export async function mergePullRequest(prNumber: number) {
  ensureConfig();
  const res = await ghFetch(repoUrl(`/pulls/${prNumber}/merge`), {
    method: "PUT",
    body: JSON.stringify({ merge_method: "merge" }),
  });
  if (!res.ok) {
    throw new Error(`Failed to merge PR: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

export function getGitHubPRUrl(prNumber: number): string {
  return `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/pull/${prNumber}`;
}
