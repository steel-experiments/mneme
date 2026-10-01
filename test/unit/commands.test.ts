import { describe, it, expect } from 'vitest';
import { ApplicationCommandOptionType } from 'discord.js';
import {
  MNEME_COMMAND_NAME,
  MNEME_SUBCOMMANDS,
  MNEME_SUBCOMMAND_GROUPS,
  MNEME_COMMANDS,
  buildMnemeCommand,
  listCommandEndpoints,
  registerGuildCommands,
  isAuthorizedAdmin,
  type CommandRegistrationRest,
} from '../../src/platform/discord/commands.js';

/**
 * Guild-scoped admin command registry (Section 27).
 *
 * The registered guild command surface must match Section 27 exactly, and a
 * registration failure must leave readiness false. These tests assert the surface
 * against the declarative spec and the compiled REST payload, and exercise the
 * admin-role gate (Section 6.6) and registration outcome.
 */

const ROOT_SUBCOMMANDS = new Set(MNEME_SUBCOMMANDS.map((s) => s.name));

describe('command surface matches Section 27', () => {
  it('declares exactly the sixteen flat admin subcommands', () => {
    expect(MNEME_SUBCOMMANDS).toHaveLength(16);
    for (const name of [
      'status',
      'mode',
      'channels',
      'sync',
      'pause',
      'resume',
      'proposals',
      'approve',
      'dismiss',
      'memory-search',
      'memory-get',
      'forget-message',
      'forget-user',
      'reload-policy',
      'backup',
      'integrity-check',
    ]) {
      expect(ROOT_SUBCOMMANDS.has(name), `missing flat subcommand ${name}`).toBe(true);
    }
  });

  it('declares the mcp-token and inspector-token groups with create / list / revoke', () => {
    expect(MNEME_SUBCOMMAND_GROUPS).toHaveLength(5);
    const group = MNEME_SUBCOMMAND_GROUPS.find((g) => g.name === 'mcp-token')!;
    expect(group.name).toBe('mcp-token');
    expect(group.subcommands.map((s) => s.name).sort()).toEqual(['create', 'list', 'revoke']);
    const inspector = MNEME_SUBCOMMAND_GROUPS.find((g) => g.name === 'inspector-token')!;
    expect(inspector.name).toBe('inspector-token');
    expect(inspector.subcommands.map((s) => s.name).sort()).toEqual(['create', 'list', 'revoke']);
  });

  it('flattens to the full thirty-three Section 27 endpoints', () => {
    expect(listCommandEndpoints()).toHaveLength(33);
    expect(listCommandEndpoints()).toContain('mcp-token create');
    expect(listCommandEndpoints()).toContain('mcp-token revoke');
    expect(listCommandEndpoints()).toContain('inspector-token create');
    expect(listCommandEndpoints()).toContain('inspector-token revoke');
    expect(listCommandEndpoints()).toContain('historical pause');
    expect(listCommandEndpoints()).toContain('recap start');
    expect(listCommandEndpoints()).toContain('recap retry');
  });

  it('gives every subcommand a non-empty description (Discord requires one)', () => {
    for (const s of MNEME_SUBCOMMANDS) expect(s.description.length).toBeGreaterThan(0);
    for (const g of MNEME_SUBCOMMAND_GROUPS) {
      expect(g.description.length).toBeGreaterThan(0);
      for (const s of g.subcommands) expect(s.description.length).toBeGreaterThan(0);
    }
  });
});

describe('subcommand options', () => {
  const flat = new Map(MNEME_SUBCOMMANDS.map((s) => [s.name, s]));

  it('approve and dismiss require a proposal id', () => {
    for (const name of ['approve', 'dismiss']) {
      const opts = flat.get(name)!.options;
      const id = opts.find((o) => o.name === 'id');
      expect(id, `${name} needs an id option`).toBeDefined();
      expect(id!.required).toBe(true);
    }
  });

  it('memory-search requires a query', () => {
    const q = flat.get('memory-search')!.options.find((o) => o.name === 'query');
    expect(q?.required).toBe(true);
  });

  it('forget-message requires a message ID and forget-user uses a Discord user picker', () => {
    expect(flat.get('forget-message')!.options[0]).toMatchObject({ name: 'id', kind: 'string', required: true });
    expect(flat.get('forget-user')!.options[0]).toMatchObject({ name: 'user', kind: 'user', required: true });
  });

  it('sync exposes an optional channel filter', () => {
    const channel = flat.get('sync')!.options.find((o) => o.name === 'channel');
    expect(channel?.required).toBe(false);
    expect(channel?.kind).toBe('channel');
  });

  it('mode requires a constrained value and has optional autonomous confirmation', () => {
    const options = flat.get('mode')!.options;
    const value = options.find((o) => o.name === 'value')!;
    expect(value.required).toBe(true);
    expect(value.choices?.map((choice) => choice.value)).toEqual([
      'configured', 'observe', 'review', 'autonomous',
    ]);
    expect(options.find((o) => o.name === 'confirmation')?.required).toBe(false);
  });

  it('mcp-token create requires a name and accepts optional channels; revoke requires id', () => {
    const group = MNEME_SUBCOMMAND_GROUPS.find((g) => g.name === 'mcp-token')!;
    const byName = new Map(group.subcommands.map((s) => [s.name, s]));
    const create = byName.get('create')!;
    expect(create.options.find((o) => o.name === 'name')!.required).toBe(true);
    expect(create.options.find((o) => o.name === 'channels')!.required).toBe(false);
    expect(byName.get('revoke')!.options.find((o) => o.name === 'id')!.required).toBe(true);
    expect(byName.get('list')!.options).toEqual([]);
  });

  it('mcp-token create accepts an optional integer expires-days', () => {
    const group = MNEME_SUBCOMMAND_GROUPS.find((g) => g.name === 'mcp-token')!;
    const create = group.subcommands.find((s) => s.name === 'create')!;
    const expires = create.options.find((o) => o.name === 'expires-days')!;
    expect(expires.required).toBe(false);
    expect(expires.kind).toBe('integer');
  });

  it('inspector-token create requires a name and takes optional expires-days; revoke requires id', () => {
    const group = MNEME_SUBCOMMAND_GROUPS.find((g) => g.name === 'inspector-token')!;
    const byName = new Map(group.subcommands.map((s) => [s.name, s]));
    const create = byName.get('create')!;
    expect(create.options.find((o) => o.name === 'name')!.required).toBe(true);
    const expires = create.options.find((o) => o.name === 'expires-days')!;
    expect(expires.required).toBe(false);
    expect(expires.kind).toBe('integer');
    expect(byName.get('revoke')!.options.find((o) => o.name === 'id')!.required).toBe(true);
    expect(byName.get('list')!.options).toEqual([]);
  });
});

describe('compiled REST payload', () => {
  const payload = MNEME_COMMANDS[0] as {
    name: string;
    description: string;
    options?: Array<{
      type: number;
      name: string;
      description?: string;
      options?: Array<{ type: number; name: string; required?: boolean }>;
    }>;
  };

  it('is one root command named mneme', () => {
    expect(MNEME_COMMANDS).toHaveLength(1);
    expect(payload.name).toBe(MNEME_COMMAND_NAME);
    expect(payload.description.length).toBeGreaterThan(0);
  });

  it('compiles deterministically from the spec', () => {
    const rebuilt = buildMnemeCommand().toJSON() as typeof payload;
    expect(rebuilt).toEqual(payload);
  });

  it('emits every flat subcommand and the mcp-token group with the right option types', () => {
    const opts = payload.options ?? [];
    const subTypes = new Map(opts.map((o) => [o.name, o.type]));
    // 16 subcommands + 5 groups.
    expect(opts).toHaveLength(21);
    for (const name of MNEME_SUBCOMMANDS.map((s) => s.name)) {
      expect(subTypes.get(name)).toBe(ApplicationCommandOptionType.Subcommand);
    }
    const group = opts.find((o) => o.name === 'mcp-token')!;
    expect(group.type).toBe(ApplicationCommandOptionType.SubcommandGroup);
    expect(group.options!.map((o) => o.name).sort()).toEqual(['create', 'list', 'revoke']);
    // A string option serializes with type String and the required flag.
    const approve = opts.find((o) => o.name === 'approve')!;
    const idOpt = approve.options!.find((o) => o.name === 'id')!;
    expect(idOpt.type).toBe(ApplicationCommandOptionType.String);
    expect(idOpt.required).toBe(true);
  });
});

describe('admin-role authorization (Section 6.6)', () => {
  it('authorizes a member holding a configured admin role', () => {
    expect(isAuthorizedAdmin(['111', '222'], ['222', '333'])).toBe(true);
  });

  it('rejects a member with no admin role', () => {
    expect(isAuthorizedAdmin(['111', '444'], ['222', '333'])).toBe(false);
  });

  it('fails closed when no admin roles are configured', () => {
    // Nobody is authorized — restricted commands stay unusable rather than open.
    expect(isAuthorizedAdmin(['111'], [])).toBe(false);
    expect(isAuthorizedAdmin([], [])).toBe(false);
  });
});

describe('guild command registration', () => {
  function makeRest(behavior: 'resolve' | 'reject'): {
    rest: CommandRegistrationRest;
    calls: Array<{ route: string; body: unknown }>;
  } {
    const calls: Array<{ route: string; body: unknown }> = [];
    const rest: CommandRegistrationRest = {
      async put(route, options) {
        calls.push({ route, body: options.body });
        if (behavior === 'reject') throw new Error('rate limited');
        return [];
      },
    };
    return { rest, calls };
  }

  it('puts the canonical payload on the guild route and returns ok', async () => {
    const { rest, calls } = makeRest('resolve');
    const res = await registerGuildCommands({
      rest,
      applicationId: '700000000000000001',
      guildId: '700000000000000002',
    });
    expect(res).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.route).toContain('700000000000000001');
    expect(calls[0]!.route).toContain('700000000000000002');
    expect(calls[0]!.body).toBe(MNEME_COMMANDS);
  });

  it('returns ok:false on registration failure so readiness stays false', async () => {
    const { rest } = makeRest('reject');
    const res = await registerGuildCommands({
      rest,
      applicationId: '700000000000000001',
      guildId: '700000000000000002',
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('rate limited');
  });

  it('honors an explicit payload override', async () => {
    const { rest, calls } = makeRest('resolve');
    const custom = [{ name: 'standalone', description: 'd', options: [] }];
    await registerGuildCommands({
      rest,
      applicationId: 'a',
      guildId: 'g',
      commands: custom,
    });
    expect(calls[0]!.body).toBe(custom);
  });
});
