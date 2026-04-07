"use client";

import { useEffect } from "react";

/**
 * Route-level error boundary. Catches client-side render errors anywhere in
 * the app tree (the chat panel's streaming logic, the canvas renderer, the
 * marketplace, etc.) and shows a recoverable UI instead of a white screen.
 *
 * Next.js requires this file to be a client component named exactly
 * `error.tsx` at the route segment it should guard. Placing it at the app
 * root catches any uncaught render error in any page.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[error-boundary]", error);
  }, [error]);

  return (
    <div className="relative flex h-screen w-screen items-center justify-center overflow-hidden">
      <div
        className="absolute inset-0 bg-cover bg-center bg-no-repeat"
        style={{ backgroundImage: "url('/bg.avif')" }}
      />
      <div className="absolute inset-0 backdrop-blur-xl bg-black/60" />
      <div className="relative z-10 flex max-w-md flex-col items-center gap-4 rounded-2xl border border-white/15 bg-white/10 p-8 text-center backdrop-blur-md">
        <h1 className="text-2xl font-bold text-white">Something went wrong</h1>
        <p className="text-sm text-white/60">
          {error.message || "An unexpected error occurred while rendering this page."}
        </p>
        {error.digest && (
          <p className="font-mono text-[10px] text-white/30">digest: {error.digest}</p>
        )}
        <button
          onClick={reset}
          className="rounded-full bg-[#e0a96e] px-4 py-1.5 text-sm font-medium text-stone-900 transition-colors hover:bg-[#f0bb84]"
        >
          Try again
        </button>
      </div>
    </div>
  );
}
