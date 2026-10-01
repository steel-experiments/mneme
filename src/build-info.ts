import { APP_VERSION } from './version.js';

/** Safe, non-secret identity for the running application build/deployment. */
export interface BuildInfo {
  /** package.json application version. */
  appVersion: string;
  /** Git/source revision only when a deployment environment supplies one explicitly. */
  sourceRevision: string | null;
  /** Railway's deployment UUID, available for GitHub and CLI-upload deploys. */
  railwayDeploymentId: string | null;
  /** Provider-neutral build identifier used only when no Railway deployment id exists. */
  buildId: string | null;
}

type Environment = Record<string, string | undefined>;

const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const SAFE_REVISION = /^[0-9a-f]{7,64}$/i;

/**
 * Normalize an injected build identity before it reaches logs or status output.
 * Only compact identifier-shaped values survive; arbitrary environment text,
 * whitespace, mentions, and control characters fail closed to null.
 */
export function normalizeBuildInfo(input: Partial<BuildInfo>): BuildInfo {
  return {
    // Application version is an immutable property of the built package. An
    // ambient or injected environment value must never relabel the artifact.
    appVersion: APP_VERSION,
    sourceRevision: safeRevision(input.sourceRevision),
    railwayDeploymentId: safeIdentifier(input.railwayDeploymentId, 128),
    buildId: safeIdentifier(input.buildId, 128),
  };
}

/**
 * Resolve build identity from a small allowlist of runtime environment values.
 *
 * Railway always supplies `RAILWAY_DEPLOYMENT_ID`. Git fields are supplied only
 * for GitHub-triggered deployments, so a CLI upload truthfully has no source
 * revision unless the operator explicitly provides one. Provider-neutral
 * fallbacks support other CI systems without inspecting `.git` at runtime (an
 * uploaded working tree may contain uncommitted changes).
 */
export function resolveBuildInfo(environment: Environment = process.env): BuildInfo {
  return normalizeBuildInfo({
    appVersion: APP_VERSION,
    sourceRevision: firstRevision(environment, [
      'MNEME_SOURCE_REVISION',
      'RAILWAY_GIT_COMMIT_SHA',
      'GITHUB_SHA',
      'CI_COMMIT_SHA',
    ]),
    railwayDeploymentId: environment.RAILWAY_DEPLOYMENT_ID,
    buildId: firstIdentifier(environment, [
      'MNEME_BUILD_ID',
    ]),
  });
}

function firstRevision(environment: Environment, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = safeRevision(environment[key]);
    if (value !== null) return value;
  }
  return null;
}

function firstIdentifier(environment: Environment, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = safeIdentifier(environment[key], 128);
    if (value !== null) return value;
  }
  return null;
}

function safeRevision(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && SAFE_REVISION.test(trimmed) ? trimmed.toLowerCase() : null;
}

function safeIdentifier(value: string | null | undefined, maxLength: number): string | null {
  const trimmed = value?.trim();
  if (!trimmed || trimmed.length > maxLength || !SAFE_IDENTIFIER.test(trimmed)) return null;
  return trimmed;
}
