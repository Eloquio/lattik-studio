import { notFound } from "next/navigation";
import { RequestDetail } from "@/components/requests/request-detail";
import { getRequestDetail } from "@/lib/actions/requests";

export default async function RequestDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const detail = await getRequestDetail(id);
  if (!detail) notFound();

  return <RequestDetail request={detail.request} runs={detail.runs} />;
}
