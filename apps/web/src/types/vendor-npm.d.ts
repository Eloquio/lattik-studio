// Ambient declarations for npm-cli packages that ship no types.
// We only declare the narrow surface used by `@/lib/github-packages`.

declare module "libnpmpublish" {
  /** Publish a package. `manifest` is the parsed package.json; `tarball` is
   *  the gzipped npm tarball buffer. Auth + registry come from `opts`
   *  (forwarded to npm-registry-fetch). */
  export function publish(
    manifest: unknown,
    tarball: Buffer,
    opts?: Record<string, unknown>,
  ): Promise<unknown>;
  export function unpublish(
    spec: string,
    opts?: Record<string, unknown>,
  ): Promise<unknown>;
}

declare module "npm-registry-fetch" {
  type Opts = Record<string, unknown>;
  interface NpmRegistryFetch {
    (url: string, opts?: Opts): Promise<unknown>;
    json(url: string, opts?: Opts): Promise<unknown>;
    pickRegistry(spec: string, opts?: Opts): string;
  }
  const npmFetch: NpmRegistryFetch;
  export = npmFetch;
}
