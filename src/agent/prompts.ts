import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import Handlebars from 'handlebars';
import { messageLink } from '../platform/links.js';

/**
 * Strict prompt compilation and helpers (Section 15.2).
 *
 * All templates compile on an isolated Handlebars instance in strict mode with
 * noEscape, registering only the allowlisted helpers (`json`, `join`, `isoDate`,
 * `messageLink`). Discord transcripts and retrieved documents enter prompts only as
 * serialized data through the `json` helper — never as compiled template code — and
 * every render context is sanitized into null-prototype objects so inherited
 * prototype properties (`toString`, `constructor`, …) are unreachable. Missing
 * required values throw under strict mode rather than rendering as empty text, and a
 * missing template file raises a typed `PromptLoadError`.
 */

/** The complete set of helpers a Mneme prompt may use (Section 15.2). */
export const ALLOWED_HELPERS = ['json', 'join', 'isoDate', 'messageLink'] as const;
export type AllowedHelper = (typeof ALLOWED_HELPERS)[number];

export type TaskTemplateName = 'system' | 'episode-review' | 'direct-answer' | 'scheduled-review';
export const TASK_TEMPLATE_FILES: Record<TaskTemplateName, string> = {
  system: 'system.hbs',
  'episode-review': 'episode-review.hbs',
  'direct-answer': 'direct-answer.hbs',
  'scheduled-review': 'scheduled-review.hbs',
};

export type PartialName = 'personality' | 'boundaries' | 'memory-taxonomy';
export const PARTIAL_FILES: Record<PartialName, string> = {
  personality: path.join('partials', 'personality.hbs'),
  boundaries: path.join('partials', 'boundaries.hbs'),
  'memory-taxonomy': path.join('partials', 'memory-taxonomy.hbs'),
};
export const PARTIAL_NAMES: readonly PartialName[] = ['personality', 'boundaries', 'memory-taxonomy'];

export interface PromptFiles {
  readonly system: string;
  readonly 'episode-review': string;
  readonly 'direct-answer': string;
  readonly 'scheduled-review': string;
  readonly partials: Record<PartialName, string>;
}

const COMPILE_OPTIONS = { strict: true, noEscape: true } as const;

type HandlebarsInstance = ReturnType<typeof Handlebars.create>;
/** A compiled template delegate, derived from the instance to avoid a fragile named import. */
type CompiledTemplate = ReturnType<HandlebarsInstance['compile']>;

/* -------------------------------------------------------------------------- */
/* Allowlisted helpers                                                        */
/* -------------------------------------------------------------------------- */

/** Join an array into a string; non-arrays render empty (never throw). */
export function joinHelper(values: unknown, separator: unknown = ', '): string {
  return Array.isArray(values) ? values.join(typeof separator === 'string' ? separator : ', ') : '';
}

/** Format an epoch millisecond value as an ISO string; invalid input renders empty. */
export function isoDateHelper(ms: unknown): string {
  return typeof ms === 'number' && Number.isFinite(ms) ? new Date(ms).toISOString() : '';
}

/**
 * Build a trusted Discord message link from snowflake IDs. Returns the empty string
 * unless all three IDs are present non-empty strings, so a partial or untrusted
 * reference never produces a misleading link.
 */
export function messageLinkHelper(guildId: unknown, channelId: unknown, messageId: unknown): string {
  if (typeof guildId !== 'string' || typeof channelId !== 'string' || typeof messageId !== 'string') return '';
  if (guildId.length === 0 || channelId.length === 0 || messageId.length === 0) return '';
  return messageLink(guildId, channelId, messageId);
}

function registerHelpers(hbs: HandlebarsInstance): void {
  // `json` serializes untrusted content with JSON.stringify and returns a safe
  // literal — the value is data, never executed as a template.
  hbs.registerHelper('json', (value: unknown) => new hbs.SafeString(JSON.stringify(value, null, 2)));
  hbs.registerHelper('join', joinHelper);
  hbs.registerHelper('isoDate', isoDateHelper);
  hbs.registerHelper('messageLink', messageLinkHelper);
}

function registerPartials(hbs: HandlebarsInstance, partials: PromptFiles['partials']): void {
  for (const name of PARTIAL_NAMES) hbs.registerPartial(name, partials[name]);
}

/* -------------------------------------------------------------------------- */
/* Context sanitization — no prototype-property access                        */
/* -------------------------------------------------------------------------- */

/**
 * Recursively copy plain object literals into null-prototype objects so that
 * inherited properties (`toString`, `constructor`, `__proto__`) are not reachable
 * from a template. Arrays are copied element-wise; non-plain objects (Date, class
 * instances, already null-prototype objects) are passed through unchanged.
 */
export function sanitizePromptData<T>(value: T): T {
  return walk(value) as T;
}

function walk(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(walk);
  if (value !== null && typeof value === 'object') {
    // Only re-create plain object literals; leave richer types intact.
    if (Object.getPrototypeOf(value) !== Object.prototype) return value;
    const out: Record<string, unknown> = Object.create(null);
    for (const key of Object.keys(value)) out[key] = walk((value as Record<string, unknown>)[key]);
    return out;
  }
  return value;
}

/* -------------------------------------------------------------------------- */
/* Prompt version (Section 15.2)                                              */
/* -------------------------------------------------------------------------- */

export interface PromptVersionParts {
  /** The system prompt source. */
  readonly system: string;
  /** The task template source for this run. */
  readonly taskTemplate: string;
  /** Partial sources, in canonical order. */
  readonly partials: readonly string[];
  /** `mneme.yml` content, if available. */
  readonly mnemeYml?: string;
  /** `channel-policy.yml` content, if available. */
  readonly channelPolicyYml?: string;
}

/**
 * Encode one section as its UTF-8 byte length, a space, then the content. The length
 * prefix makes the encoding injective: no section content — not even one carrying
 * the delimiter or a newline — can shift a boundary and collide with a
 * different source tuple.
 */
function lengthPrefixedSection(content: string): string {
  return `${Buffer.byteLength(content, 'utf8')} ${content}`;
}

/**
 * Compute the SHA-256 prompt version recorded for a run (Section 15.2). Every input
 * that can change a rendered prompt is its own section: the system template, the
 * selected task template, each partial in canonical order, the Mneme YAML, and
 * the channel-policy YAML. Sections are length-prefixed and concatenated, so the
 * hash is stable for identical files and changes when any single input changes,
 * with no possibility of a boundary collision. The version is stored with each
 * agent run so a changed prompt is always attributable.
 */
export function computePromptVersion(parts: PromptVersionParts): string {
  const sections = [
    parts.system,
    parts.taskTemplate,
    ...parts.partials,
    parts.mnemeYml ?? '',
    parts.channelPolicyYml ?? '',
  ];
  const canonical = sections.map(lengthPrefixedSection).join('');
  return crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/* -------------------------------------------------------------------------- */
/* Compiler                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Compiles Mneme's prompt surface once and renders task prompts safely. Templates
 * are compiled in strict mode with only the allowlisted helpers; render contexts are
 * sanitized to block prototype-property access; missing values throw.
 */
export class PromptCompiler {
  readonly files: PromptFiles;
  readonly helpers = ALLOWED_HELPERS;
  private readonly hbs: HandlebarsInstance;
  private readonly compiled: Record<TaskTemplateName, CompiledTemplate>;

  constructor(files: PromptFiles) {
    this.files = files;
    const hbs = Handlebars.create();
    registerHelpers(hbs);
    registerPartials(hbs, files.partials);
    this.hbs = hbs;
    this.compiled = {
      system: hbs.compile(files.system, COMPILE_OPTIONS),
      'episode-review': hbs.compile(files['episode-review'], COMPILE_OPTIONS),
      'direct-answer': hbs.compile(files['direct-answer'], COMPILE_OPTIONS),
      'scheduled-review': hbs.compile(files['scheduled-review'], COMPILE_OPTIONS),
    };
  }

  /** Compile an ad-hoc source under the same strict rules (helpers/partials apply). */
  compile(source: string): CompiledTemplate {
    return this.hbs.compile(source, COMPILE_OPTIONS);
  }

  /** Render a named task template; the context is sanitized before rendering. */
  render(name: TaskTemplateName, context: Record<string, unknown>): string {
    return this.compiled[name](sanitizePromptData(context));
  }

  /** SHA-256 prompt version for a specific task run (Section 15.2). */
  versionFor(
    task: TaskTemplateName,
    configs?: { mnemeYml?: string; channelPolicyYml?: string },
  ): string {
    return computePromptVersion({
      system: this.files.system,
      taskTemplate: task === 'system' ? '' : this.files[task],
      partials: PARTIAL_NAMES.map((p) => this.files.partials[p]),
      mnemeYml: configs?.mnemeYml,
      channelPolicyYml: configs?.channelPolicyYml,
    });
  }
}

/* -------------------------------------------------------------------------- */
/* Loading                                                                    */
/* -------------------------------------------------------------------------- */

/** Raised when a prompt template or partial cannot be read from disk. */
export class PromptLoadError extends Error {
  constructor(
    public readonly path: string,
    cause: unknown,
  ) {
    const msg = cause instanceof Error ? cause.message : String(cause);
    super(`failed to load prompt file "${path}": ${msg}`);
    this.name = 'PromptLoadError';
  }
}

/** Read the seven canonical prompt files from `promptDir`. Throws on any missing file. */
export function loadPromptFiles(promptDir: string): PromptFiles {
  const read = (rel: string): string => {
    const full = path.join(promptDir, rel);
    try {
      return fs.readFileSync(full, 'utf8');
    } catch (err) {
      throw new PromptLoadError(rel, err);
    }
  };
  const partials: Record<PartialName, string> = {
    personality: read(PARTIAL_FILES.personality),
    boundaries: read(PARTIAL_FILES.boundaries),
    'memory-taxonomy': read(PARTIAL_FILES['memory-taxonomy']),
  };
  return {
    system: read(TASK_TEMPLATE_FILES.system),
    'episode-review': read(TASK_TEMPLATE_FILES['episode-review']),
    'direct-answer': read(TASK_TEMPLATE_FILES['direct-answer']),
    'scheduled-review': read(TASK_TEMPLATE_FILES['scheduled-review']),
    partials,
  };
}

/** Load and compile the prompt surface from `promptDir`. */
export function loadPromptCompiler(promptDir: string): PromptCompiler {
  return new PromptCompiler(loadPromptFiles(promptDir));
}

/**
 * Raised by {@link validatePromptStructure} when a template or partial fails to
 * compile or dry-render.
 */
export class PromptStructureError extends Error {
  constructor(
    public readonly template: string,
    cause: unknown,
  ) {
    const msg = cause instanceof Error ? cause.message : String(cause);
    super(`prompt template "${template}" failed to compile or dry-render: ${msg}`);
    this.name = 'PromptStructureError';
  }
}

/**
 * Compile and dry-render every task template and partial against an empty
 * context on a non-strict instance (with the allowlisted helpers and partials
 * registered). Structural errors — unclosed blocks, malformed expressions,
 * references to partials that are not part of the fixed set — throw here, so a
 * broken prompt surface is rejected before a reload swaps it live. Missing
 * values are expected at this stage and do not fail the check: non-strict mode
 * renders them empty rather than throwing, so only genuine structural breakage
 * is caught.
 */
export function validatePromptStructure(files: PromptFiles): void {
  const hbs = Handlebars.create();
  registerHelpers(hbs);
  registerPartials(hbs, files.partials);
  const targets: Array<[string, string]> = [
    ['system', files.system],
    ['episode-review', files['episode-review']],
    ['direct-answer', files['direct-answer']],
    ['scheduled-review', files['scheduled-review']],
    ['partial:personality', files.partials.personality],
    ['partial:boundaries', files.partials.boundaries],
    ['partial:memory-taxonomy', files.partials['memory-taxonomy']],
  ];
  for (const [name, src] of targets) {
    try {
      const tpl = hbs.compile(src, { noEscape: true });
      tpl({});
    } catch (err) {
      throw new PromptStructureError(name, err);
    }
  }
}
