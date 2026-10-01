import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Railway deployment configuration (Section 41; task T112).
 *
 * Acceptance — verbatim: "The Railway configuration validates and contains no
 * replica, pre-deploy migration, or ephemeral database assumption."
 *
 * The committed `railway.json` was also validated against Railway's live JSON
 * schema (`https://railway.com/railway.schema.json`, draft-07) with ajv at
 * authoring time: valid. That check is network-dependent, so the durable guard
 * here pins the spec-required fields (Section 41.1) and forbids the constructs
 * the acceptance criterion names.
 */

type Rail = {
  $schema?: string;
  build?: { builder?: unknown; dockerfilePath?: unknown; [k: string]: unknown };
  deploy?: {
    healthcheckPath?: unknown;
    healthcheckTimeout?: unknown;
    restartPolicyType?: unknown;
    [k: string]: unknown;
  };
  [k: string]: unknown;
};

const RAILWAY = fileURLToPath(new URL('../../railway.json', import.meta.url));
const cfg = JSON.parse(readFileSync(RAILWAY, 'utf8')) as Rail;

describe('railway.json (Section 41.1)', () => {
  it('references the Railway schema', () => {
    expect(cfg.$schema).toBe('https://railway.com/railway.schema.json');
  });

  it('builds the repository Dockerfile', () => {
    expect(cfg.build?.builder).toBe('DOCKERFILE');
    expect(cfg.build?.dockerfilePath).toBe('Dockerfile');
  });

  it('probes /readyz with a 300 s timeout', () => {
    expect(cfg.deploy?.healthcheckPath).toBe('/readyz');
    expect(cfg.deploy?.healthcheckTimeout).toBe(300);
  });

  it('always restarts the singleton', () => {
    expect(cfg.deploy?.restartPolicyType).toBe('ALWAYS');
  });

  it('declares no replica count', () => {
    // A volume-backed service cannot use replicas (Section 41.3); singleton only.
    for (const key of ['numReplicas', 'replicas', 'replicaCount']) {
      expect(cfg.deploy).not.toHaveProperty(key);
    }
  });

  it('declares no pre-deploy migration command', () => {
    // Railway volumes are not mounted during pre-deploy; the app migrates at
    // startup (bootstrap.ts Step 1), so no pre-deploy command may exist.
    for (const key of ['preDeployCommand', 'preDeploy', 'predeploy']) {
      expect(cfg).not.toHaveProperty(key);
      expect(cfg.deploy).not.toHaveProperty(key);
    }
  });

  it('makes no ephemeral-database assumption', () => {
    // No inline DATABASE_PATH override: the persistent path comes from the
    // base compose / app config (/app/data/mneme.sqlite on the volume).
    expect(cfg.deploy).not.toHaveProperty('DATABASE_PATH');
    expect(cfg).not.toHaveProperty('ephemeralFileSystem');
  });
});
