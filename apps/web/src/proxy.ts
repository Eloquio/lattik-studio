export { auth as proxy } from "@/auth";

export const config = {
  matcher: ["/((?!sign-in|api/auth|api/webhooks|_next/static|_next/image|favicon.ico|bg.avif).*)"],
};
