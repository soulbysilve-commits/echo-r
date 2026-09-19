/**
 * Read-only release identity of the RUNNING deployment, served by
 * app/api/release-identity/route.ts. veritas-release-orchestrator's
 * OfficialSiteAdapter fetches it during post-validation to prove the
 * live Production site is serving the exact candidate revision -- a
 * check that cannot be satisfied by anything the orchestrator wrote
 * locally, because every value here comes from the deployed artifact
 * or from Vercel's own runtime for THIS deployment.
 *
 * Sources of each field:
 *   - source_revision: VERITAS_RELEASE_SOURCE_REVISION, passed by the
 *     orchestrator as `vercel deploy --build-env` and inlined into the
 *     bundle by next.config.ts's `env` at build time. A deployment made
 *     by hand (no build-env) reports null -- never a guess.
 *   - deployment_id / environment: VERCEL_DEPLOYMENT_ID / VERCEL_ENV,
 *     set by Vercel itself for this deployment (autoExposeSystemEnvs is
 *     on for this project).
 *   - sales_live_enabled: the RESULT of isStripeLiveSalesEnabled(),
 *     supplied by the route as a boolean. The flag's value, any key, or
 *     any prefix/suffix/hash of one is never read into this module and
 *     can never appear in the payload -- there is no field for it.
 *
 * Every string is validated against a strict shape before it is
 * exposed; anything malformed becomes null rather than being echoed.
 */

export const RELEASE_IDENTITY_SCHEMA = "veritasforge.release-identity/v1";

const GIT_SHA_PATTERN = /^[0-9a-f]{40}$/;
const DEPLOYMENT_ID_PATTERN = /^dpl_[A-Za-z0-9]{6,64}$/;
const KNOWN_ENVIRONMENTS = ["production", "preview", "development"] as const;
type KnownEnvironment = (typeof KNOWN_ENVIRONMENTS)[number];

export interface ReleaseIdentity {
  schema: typeof RELEASE_IDENTITY_SCHEMA;
  source_revision: string | null;
  deployment_id: string | null;
  environment: KnownEnvironment | null;
  sales_live_enabled: boolean;
}

export interface ReleaseIdentityEnv {
  VERITAS_RELEASE_SOURCE_REVISION?: string;
  VERCEL_DEPLOYMENT_ID?: string;
  VERCEL_ENV?: string;
}

export function normalizeSourceRevision(raw: string | undefined): string | null {
  const value = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  return GIT_SHA_PATTERN.test(value) ? value : null;
}

export function normalizeDeploymentId(raw: string | undefined): string | null {
  const value = typeof raw === "string" ? raw.trim() : "";
  return DEPLOYMENT_ID_PATTERN.test(value) ? value : null;
}

export function normalizeEnvironment(raw: string | undefined): KnownEnvironment | null {
  const value = typeof raw === "string" ? raw.trim() : "";
  return (KNOWN_ENVIRONMENTS as readonly string[]).includes(value) ? (value as KnownEnvironment) : null;
}

/** `salesLiveEnabled` must be the boolean RESULT of the existing sales
 * gate, never an env value. Anything that is not exactly `true` is
 * reported as false (fail closed toward "sales are not live"). */
export function buildReleaseIdentity(env: ReleaseIdentityEnv, salesLiveEnabled: boolean): ReleaseIdentity {
  return {
    schema: RELEASE_IDENTITY_SCHEMA,
    source_revision: normalizeSourceRevision(env.VERITAS_RELEASE_SOURCE_REVISION),
    deployment_id: normalizeDeploymentId(env.VERCEL_DEPLOYMENT_ID),
    environment: normalizeEnvironment(env.VERCEL_ENV),
    sales_live_enabled: salesLiveEnabled === true,
  };
}
