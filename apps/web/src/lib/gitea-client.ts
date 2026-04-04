const GITEA_URL = process.env.GITEA_URL ?? "http://localhost:3300";
const GITEA_TOKEN = process.env.GITEA_TOKEN ?? "";
const GITEA_ORG = process.env.GITEA_ORG ?? "lattik";
const GITEA_REPO = process.env.GITEA_REPO ?? "definitions";

// Validate GITEA_URL at module load to prevent SSRF
if (GITEA_URL) {
  try {
    const parsed = new URL(GITEA_URL);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      throw new Error(`GITEA_URL must use http or https (got ${parsed.protocol})`);
    }
  } catch (e) {
    if (e instanceof TypeError) {
      throw new Error(`GITEA_URL is not a valid URL: ${GITEA_URL}`);
    }
    throw e;
  }
}

function ensureToken() {
  if (!GITEA_TOKEN) {
    throw new Error("GITEA_TOKEN environment variable is not set. Run 'pnpm gitea:start' and check 'pnpm gitea:init-logs' for the token.");
  }
}

function headers(): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Authorization: `token ${GITEA_TOKEN}`,
  };
}

function apiUrl(path: string): string {
  return `${GITEA_URL}/api/v1${path}`;
}

export async function createBranch(branchName: string, fromRef = "main") {
  ensureToken();
  const res = await fetch(
    apiUrl(`/repos/${GITEA_ORG}/${GITEA_REPO}/branches`),
    {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        new_branch_name: branchName,
        old_branch_name: fromRef,
      }),
    }
  );
  if (res.status === 409) {
    // Branch already exists — safe to continue
    return { name: branchName, existing: true };
  }
  if (!res.ok) {
    throw new Error(`Failed to create branch '${branchName}': ${res.status} ${await res.text()}`);
  }
  return res.json();
}

export async function commitFiles(
  branchName: string,
  files: { path: string; content: string }[],
  message: string
) {
  ensureToken();
  const res = await fetch(
    apiUrl(`/repos/${GITEA_ORG}/${GITEA_REPO}/contents`),
    {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        branch: branchName,
        message,
        files: files.map((f) => ({
          operation: "create",
          path: f.path,
          content: Buffer.from(f.content).toString("base64"),
        })),
      }),
    }
  );
  if (!res.ok) {
    // Try update if file already exists
    if (res.status === 422) {
      return commitFilesUpdate(branchName, files, message);
    }
    throw new Error(`Failed to commit ${files.length} file(s) to branch '${branchName}': ${res.status} ${await res.text()}`);
  }
  return res.json();
}

async function commitFilesUpdate(
  branchName: string,
  files: { path: string; content: string }[],
  message: string
) {
  // For updates, we need to get existing file SHAs first, then update individually
  for (const file of files) {
    const encodedPath = file.path.split("/").map(encodeURIComponent).join("/");
    const existingRes = await fetch(
      apiUrl(`/repos/${GITEA_ORG}/${GITEA_REPO}/contents/${encodedPath}?ref=${encodeURIComponent(branchName)}`),
      { headers: headers() }
    );

    const body: Record<string, unknown> = {
      message,
      branch: branchName,
      content: Buffer.from(file.content).toString("base64"),
    };

    if (existingRes.ok) {
      const existing = await existingRes.json();
      body.sha = existing.sha;
    }

    const res = await fetch(
      apiUrl(`/repos/${GITEA_ORG}/${GITEA_REPO}/contents/${encodedPath}`),
      {
        method: "PUT",
        headers: headers(),
        body: JSON.stringify(body),
      }
    );
    if (!res.ok) {
      throw new Error(`Failed to update file '${file.path}' on branch '${branchName}': ${res.status} ${await res.text()}`);
    }
  }
}

export async function createPullRequest(
  title: string,
  body: string,
  headBranch: string,
  baseBranch = "main"
) {
  ensureToken();
  const res = await fetch(
    apiUrl(`/repos/${GITEA_ORG}/${GITEA_REPO}/pulls`),
    {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        title,
        body,
        head: headBranch,
        base: baseBranch,
      }),
    }
  );
  if (!res.ok) {
    throw new Error(`Failed to create PR: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

export async function getPullRequest(prNumber: number) {
  const res = await fetch(
    apiUrl(`/repos/${GITEA_ORG}/${GITEA_REPO}/pulls/${prNumber}`),
    { headers: headers() }
  );
  if (!res.ok) {
    throw new Error(`Failed to get PR: ${res.status}`);
  }
  return res.json();
}

export async function mergePullRequest(prNumber: number) {
  const res = await fetch(
    apiUrl(`/repos/${GITEA_ORG}/${GITEA_REPO}/pulls/${prNumber}/merge`),
    {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ Do: "merge" }),
    }
  );
  if (!res.ok) {
    throw new Error(`Failed to merge PR: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

export function getGiteaPRUrl(prNumber: number): string {
  return `${GITEA_URL}/${GITEA_ORG}/${GITEA_REPO}/pulls/${prNumber}`;
}
