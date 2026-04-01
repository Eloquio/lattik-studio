export { auth as proxy } from "@/auth";

export const config = {
  matcher: ["/((?!sign-in|api/auth|_next/static|_next/image|favicon.ico|bg.avif).*)"],
};
