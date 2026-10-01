import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

/**
 * Docker Compose packaging and env parity (Section 39).
 *
 * The compose file passes the application environment through env_file. The
 * `environment:` block keeps only the container-fixed overrides with absolute
 * /app values; every other setting flows from .env, and the application does
 * the validation with better messages. Because of that, no ${VAR} interpolation
 * may remain in the file.
 *
 * Parity runs in both directions:
 *  - forward: every uncommented KEY= in the example env files either carries
 *    the container-fixed value (a container overrides that key, so a different
 *    example value would be silently lost) or reaches the process through
 *    env_file;
 *  - reverse: every env var name src/config.ts reads appears in
 *    config/advanced.env.example, minus the platform-injected exception list.
 *
 * The structural hardening assertions (one service, read-only root filesystem,
 * tmpfs, no host port in the base file) remain in force.
 */

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const COMPOSE = `${ROOT}docker-compose.yml`;
const OVERRIDE = `${ROOT}docker-compose.override.example.yml`;
const ENV_EXAMPLE = `${ROOT}.env.example`;
const ADVANCED_ENV_EXAMPLE = `${ROOT}config/advanced.env.example`;
const CONFIG_SRC = `${ROOT}src/config.ts`;

/**
 * The only keys compose may pin in `environment:`. The Dockerfile runtime
 * stage bakes the same absolute values as ENV, so containers are unaffected by
 * the cwd-relative application defaults.
 */
const CONTAINER_FIXED = {
  NODE_ENV: 'production',
  HOME: '/tmp',
  DATA_DIR: '/app/data',
  DATABASE_PATH: '/app/data/mneme.sqlite',
  PROMPT_DIR: '/app/prompts',
  DOCS_DIR: '/app/docs',
  MNEME_CONFIG_PATH: '/app/config/mneme.yml',
  CHANNEL_POLICY_PATH: '/app/config/channel-policy.yml',
} as const;

/**
 * Names src/config.ts reads but no example file should carry: the platform
 * injects them. RAILWAY_PUBLIC_DOMAIN arrives from the Railway environment.
 * No build-identity variable is read in src/config.ts today. Extend this list
 * only with names the platform injects.
 */
const PLATFORM_INJECTED = new Set(['RAILWAY_PUBLIC_DOMAIN']);

function dockerAvailable(): boolean {
  try {
    execFileSync('docker', ['compose', 'version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const hasDocker = dockerAvailable();

/**
 * Uncommented KEY=VALUE pairs in an env example file, keyed by name; empty
 * when the file is absent. A trailing ` # comment` is not part of the value.
 */
function exampleEntries(path: string): Map<string, string> {
  const entries = new Map<string, string>();
  if (!existsSync(path)) return entries;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const match = /^[ \t]*([A-Z][A-Z0-9_]*)[ \t]*=(.*)$/.exec(line);
    if (match && match[1]) {
      const value = (match[2] ?? '').replace(/[ \t]+#.*$/, '').trim();
      entries.set(match[1], value);
    }
  }
  return entries;
}

/** KEY= names an env example file documents, including commented defaults; empty when absent. */
function documentedKeys(path: string): string[] {
  if (!existsSync(path)) return [];
  const keys = new Set<string>();
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const match = /^[ \t#]*([A-Z][A-Z0-9_]*)[ \t]*=/.exec(line);
    if (match && match[1]) keys.add(match[1]);
  }
  return [...keys].sort();
}

/** Every env var name src/config.ts reads, taken from the source text. */
function envNamesReadByConfig(): string[] {
  const src = readFileSync(CONFIG_SRC, 'utf8');
  const names = new Set<string>();
  for (const match of src.matchAll(/env\(\s*e\s*,\s*'([A-Z][A-Z0-9_]*)'\s*\)/g)) {
    if (match[1]) names.add(match[1]);
  }
  // The provider credential lookup passes a variable, not a literal; the map
  // it resolves against names the three keys.
  for (const match of src.matchAll(/:\s*'((?:OPENAI|ANTHROPIC|GOOGLE)_API_KEY)'/g)) {
    if (match[1]) names.add(match[1]);
  }
  return [...names].sort();
}

describe('Docker Compose base file (Section 39)', () => {
  const doc = parseYaml(readFileSync(COMPOSE, 'utf8')) as {
    services: Record<string, unknown>;
    volumes: Record<string, unknown>;
  };
  const mneme = doc.services['mneme'] as Record<string, unknown>;

  it('defines exactly one application service', () => {
    expect(Object.keys(doc.services)).toEqual(['mneme']);
  });

  it('mounts the named volume at /app/data', () => {
    expect(mneme['volumes']).toEqual(['mneme_data:/app/data']);
  });

  it('declares the named volume at the top level', () => {
    expect(Object.keys(doc.volumes)).toEqual(['mneme_data']);
  });

  it('sets a read-only root filesystem', () => {
    expect(mneme['read_only']).toBe(true);
  });

  it('provides a writable tmpfs at /tmp', () => {
    expect(mneme['tmpfs']).toEqual(['/tmp:size=64m,mode=1777']);
  });

  it('drops new privileges', () => {
    expect(mneme['security_opt']).toContain('no-new-privileges:true');
  });

  it('gives the shutdown drain time to finish before the container is killed', () => {
    expect(mneme['stop_grace_period']).toBe('45s');
  });

  it('exposes 3000 to siblings without publishing a host port', () => {
    expect(mneme['expose']).toEqual(['3000']);
    expect(mneme).not.toHaveProperty('ports');
  });

  it('restarts unless stopped and carries the container healthcheck', () => {
    expect(mneme['restart']).toBe('unless-stopped');
    const hc = mneme['healthcheck'] as { test: unknown };
    expect(hc.test).toEqual(['CMD', 'node', 'dist/healthcheck.js']);
  });

  it('passes the application environment through env_file including .env', () => {
    expect(mneme['env_file']).toEqual([{ path: '.env', required: false }]);
  });

  it('keeps only the container-fixed overrides in environment', () => {
    expect(mneme['environment']).toEqual({ ...CONTAINER_FIXED });
  });

  it('contains no variable interpolation or required-variable guards', () => {
    // The application validates every variable itself, with better messages.
    // Any ${VAR} here would become a second source of truth.
    expect(readFileSync(COMPOSE, 'utf8')).not.toContain('${');
  });
});

describe('local override publishes the host port on loopback only', () => {
  const doc = parseYaml(readFileSync(OVERRIDE, 'utf8')) as {
    services: { mneme: Record<string, unknown> };
  };
  const mneme = doc.services.mneme;

  it('publishes 3000 bound to 127.0.0.1', () => {
    expect(mneme['ports']).toEqual(['127.0.0.1:3000:3000']);
  });

  it('does not weaken base hardening', () => {
    expect(mneme).not.toHaveProperty('read_only');
    expect(mneme).not.toHaveProperty('security_opt');
    expect(mneme).not.toHaveProperty('tmpfs');
  });
});

describe('env reference parity (Section 39)', () => {
  const composeDoc = parseYaml(readFileSync(COMPOSE, 'utf8')) as {
    services: Record<string, unknown>;
  };
  const composeMneme = composeDoc.services['mneme'] as { env_file?: unknown };

  /** True when env_file carries .env, so non-override keys reach the process. */
  function envFileCarriesDotEnv(): boolean {
    const entries = Array.isArray(composeMneme.env_file)
      ? composeMneme.env_file
      : [];
    return entries.some(
      (entry) =>
        typeof entry === 'object' && entry !== null && (entry as { path?: unknown }).path === '.env',
    );
  }

  it('ships the basic and the advanced example env files', () => {
    expect(existsSync(ENV_EXAMPLE), `${ENV_EXAMPLE} must exist`).toBe(true);
    expect(existsSync(ADVANCED_ENV_EXAMPLE), `${ADVANCED_ENV_EXAMPLE} must exist`).toBe(true);
  });

  it('routes every example key through env_file or the container-fixed set', () => {
    expect(
      envFileCarriesDotEnv(),
      'env_file must carry .env for non-override keys to reach the process',
    ).toBe(true);

    // A key pinned by `environment:` never reaches the process from .env. When
    // an example file sets such a key to a different value, the container
    // silently overrides what the operator typed, so the example must carry
    // the container-fixed value. Every other uncommented key travels through
    // env_file, which the assertion above guarantees.
    const fixed: Record<string, string> = { ...CONTAINER_FIXED };
    const mismatches: string[] = [];
    for (const path of [ENV_EXAMPLE, ADVANCED_ENV_EXAMPLE]) {
      for (const [key, value] of exampleEntries(path)) {
        const expected = fixed[key];
        if (expected !== undefined && value !== expected) {
          mismatches.push(`${key}=${value} in ${path} (container fixes ${expected})`);
        }
      }
    }
    expect(
      mismatches,
      `container-fixed keys must carry the container value in examples: ${mismatches.join('; ')}`,
    ).toEqual([]);
  });

  it('documents every env var src/config.ts reads', () => {
    const documented = new Set(documentedKeys(ADVANCED_ENV_EXAMPLE));
    const missing = envNamesReadByConfig().filter(
      (name) => !PLATFORM_INJECTED.has(name) && !documented.has(name),
    );
    expect(
      missing,
      `config/advanced.env.example must document every env var src/config.ts reads; missing: ${missing.join(', ')}`,
    ).toEqual([]);
  });
});

describe.skipIf(!hasDocker)('docker compose config (authoritative)', () => {
  it('validates the base file as a single service', () => {
    const out = execFileSync('docker', ['compose', '-f', COMPOSE, 'config', '-q']);
    expect(out.length).toBe(0); // -q emits nothing on success
  });

  it('resolves base + override to a loopback-published port while staying read-only', () => {
    const out = execFileSync(
      'docker',
      ['compose', '-f', COMPOSE, '-f', OVERRIDE, 'config'],
    );
    const resolved = parseYaml(out.toString()) as {
      services: {
        mneme: {
          ports: Array<{ target?: number; published?: string | number; host_ip?: string }>;
          read_only: boolean;
          tmpfs: string[];
        };
      };
    };
    const mneme = resolved.services.mneme;
    const entry = mneme.ports.find((p) => p.target === 3000);
    expect(entry).toBeDefined();
    const published = String(entry?.published ?? '');
    const hostIp = entry?.host_ip ?? published.split(':')[0] ?? '';
    expect(
      [hostIp, published].join(' '),
      'the host binding must stay on loopback',
    ).toContain('127.0.0.1');
    expect(mneme.read_only).toBe(true);
    expect(mneme.tmpfs).toEqual(['/tmp:size=64m,mode=1777']);
  });
});

describe('docker-compose.image.example.yml keeps the released-image contract', () => {
  const IMAGE_EXAMPLE = `${ROOT}docker-compose.image.example.yml`;

  it('pins the same contract as the source-build compose file', () => {
    expect(existsSync(IMAGE_EXAMPLE), 'docker-compose.image.example.yml must ship').toBe(true);
    const doc = parseYaml(readFileSync(IMAGE_EXAMPLE, 'utf8')) as {
      services?: Record<string, {
        image?: string;
        build?: unknown;
        environment?: Record<string, string>;
        env_file?: Array<{ path: string; required: boolean }>;
        volumes?: string[];
        healthcheck?: { test?: string[] };
        restart?: string;
        read_only?: boolean;
        security_opt?: string[];
        tmpfs?: string[];
        stop_grace_period?: string;
        expose?: string[];
      }>;
      volumes?: Record<string, unknown>;
    };
    const svc = doc.services?.mneme;
    expect(svc, 'one mneme service').toBeDefined();
    // Released image only: never a source build, never a floating latest tag.
    // Accepted forms: `image:vX.Y.Z`, `image:vX.Y.Z@sha256:<digest>`, and
    // `image@sha256:<digest>`. A digest always follows `@`, never `:`.
    expect(svc?.build).toBeUndefined();
    expect(svc?.image ?? '').toMatch(
      /^ghcr\.io\/steel-experiments\/mneme(?::vX\.Y\.Z(?:@sha256:[0-9a-f]{64})?|@sha256:[0-9a-f]{64})$/,
    );
    // The same container-fixed override set as the source-build compose file.
    expect(svc?.environment).toEqual({ ...CONTAINER_FIXED });
    expect(svc?.env_file).toEqual([{ path: '.env', required: false }]);
    expect(svc?.volumes).toEqual(['mneme_data:/app/data']);
    expect(doc.volumes && 'mneme_data' in doc.volumes).toBe(true);
    expect(svc?.healthcheck?.test).toEqual(['CMD', 'node', 'dist/healthcheck.js']);
    expect(svc?.restart).toBe('unless-stopped');
    // The same hardening as the source-build compose file.
    expect(svc?.read_only).toBe(true);
    expect(svc?.security_opt).toContain('no-new-privileges:true');
    expect(svc?.tmpfs).toEqual(['/tmp:size=64m,mode=1777']);
    expect(svc?.stop_grace_period).toBe('45s');
    expect(svc?.expose).toEqual(['3000']);
    expect(svc).not.toHaveProperty('ports');
  });
});
