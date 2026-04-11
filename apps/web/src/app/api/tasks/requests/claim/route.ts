import { requireTaskAuth } from "@/lib/bearer-auth";
import { claimRequest } from "@/lib/task-queue";

export async function POST(req: Request) {
  const authError = requireTaskAuth(req);
  if (authError) return authError;

  // Body is currently ignored — claimRequest() doesn't track the claimer.
  // The route is POST (not GET) because claiming is a state-changing action.
  const row = await claimRequest();
  if (!row) {
    return new Response(null, { status: 204 });
  }
  return Response.json(row);
}
