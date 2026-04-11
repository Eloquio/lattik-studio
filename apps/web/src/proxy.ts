export { auth as proxy } from "@/auth";

export const config = {
  matcher: ["/((?!sign-in|api/auth|api/webhooks|api/tasks|api/cron|api/lattik|_next/static|_next/image|favicon.ico|bg.avif).*)"],
};
