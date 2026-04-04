import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import * as schema from "@/db/schema";

export async function POST(req: Request) {
  const payload = await req.json();

  // Gitea sends pull_request events with action "closed" and pull_request.merged = true
  if (payload.action !== "closed" || !payload.pull_request?.merged) {
    return Response.json({ status: "ignored" });
  }

  const prUrl = payload.pull_request.html_url as string | undefined;
  if (!prUrl) {
    return Response.json({ status: "no_pr_url" });
  }

  const db = getDb();

  // Find definitions with this PR URL and update to merged
  const definitions = await db
    .select()
    .from(schema.definitions)
    .where(eq(schema.definitions.prUrl, prUrl));

  for (const def of definitions) {
    await db
      .update(schema.definitions)
      .set({
        status: "merged",
        prMergedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(schema.definitions.id, def.id));
  }

  return Response.json({
    status: "ok",
    updatedCount: definitions.length,
  });
}
