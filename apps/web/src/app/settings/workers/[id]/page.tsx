import { notFound } from "next/navigation";
import { getWorker } from "@/lib/actions/workers";
import { WorkerDetail } from "@/components/workers/worker-detail";

export default async function WorkerDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const worker = await getWorker(id);
  if (!worker) notFound();

  return <WorkerDetail initialWorker={worker} />;
}
