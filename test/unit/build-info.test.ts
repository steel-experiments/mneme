import { describe, expect, it } from 'vitest';
import { normalizeBuildInfo, resolveBuildInfo } from '../../src/build-info.js';
import { APP_VERSION } from '../../src/version.js';

describe('build identity resolution', () => {
  it('keeps a Railway CLI upload truthful when no Git metadata exists', () => {
    const info = resolveBuildInfo({
      RAILWAY_DEPLOYMENT_ID: '00000000-0000-4000-8000-000000000001',
    });

    expect(info).toEqual({
      appVersion: APP_VERSION,
      sourceRevision: null,
      railwayDeploymentId: '00000000-0000-4000-8000-000000000001',
      buildId: null,
    });
  });

  it('uses explicit source metadata before Railway and recognized CI metadata', () => {
    const info = resolveBuildInfo({
      MNEME_SOURCE_REVISION: 'aaaaaaaa',
      RAILWAY_GIT_COMMIT_SHA: 'b'.repeat(40),
      GITHUB_SHA: 'c'.repeat(40),
      CI_COMMIT_SHA: 'd'.repeat(40),
      RAILWAY_DEPLOYMENT_ID: 'railway-deploy-123',
      MNEME_BUILD_ID: 'release-42',
    });

    expect(info.sourceRevision).toBe('aaaaaaaa');
    expect(info.railwayDeploymentId).toBe('railway-deploy-123');
    expect(info.buildId).toBe('release-42');
  });

  it('falls back to Railway Git SHA, then recognized CI SHA', () => {
    expect(resolveBuildInfo({ RAILWAY_GIT_COMMIT_SHA: 'A'.repeat(40) }).sourceRevision)
      .toBe('a'.repeat(40));
    expect(resolveBuildInfo({ GITHUB_SHA: 'B'.repeat(40) }).sourceRevision)
      .toBe('b'.repeat(40));
    expect(resolveBuildInfo({ CI_COMMIT_SHA: 'C'.repeat(40) }).sourceRevision)
      .toBe('c'.repeat(40));
  });

  it('skips an invalid explicit revision and uses valid Railway Git metadata', () => {
    expect(resolveBuildInfo({
      MNEME_SOURCE_REVISION: '<@everyone>',
      RAILWAY_GIT_COMMIT_SHA: 'd'.repeat(40),
    }).sourceRevision).toBe('d'.repeat(40));
  });

  it('ignores generic ambient labels and rejects unsafe identifier text', () => {
    const info = resolveBuildInfo({
      BUILD_ID: 'ambient-build',
      SOURCE_VERSION: 'd'.repeat(40),
      COMMIT_SHA: 'e'.repeat(40),
      MNEME_SOURCE_REVISION: '<@everyone>',
      RAILWAY_DEPLOYMENT_ID: 'deploy/with/slashes',
      MNEME_BUILD_ID: 'build\nsecret',
    });

    expect(info).toEqual({
      appVersion: APP_VERSION,
      sourceRevision: null,
      railwayDeploymentId: null,
      buildId: null,
    });
  });

  it('never lets an injected runtime object relabel the package version', () => {
    expect(normalizeBuildInfo({ appVersion: '999.0.0' }).appVersion).toBe(APP_VERSION);
  });
});
