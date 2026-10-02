# Contributing to Mneme

Mneme is small on purpose: one Node.js process, one SQLite database, one
Docker image. Keep it that way. Before you change code, read [AGENTS.md](AGENTS.md)
and the parts of [MNEME_IMPLEMENTATION_SPEC.md](MNEME_IMPLEMENTATION_SPEC.md)
that cover your change. The specification is the authority. When code and
specification disagree, fix one of them explicitly. Never let them drift apart
silently.

## Set up a local environment

You need Node.js 24 or later. You do not need a Discord server or a Slack workspace to
build and test the repository.

```bash
git clone https://github.com/steel-experiments/mneme.git
cd mneme
npm ci --ignore-scripts
npm run verify
```

`npm run verify` is the gate for every change. It runs the SQLite feature
check, lint, both type checks, the full test suite, and the build. A change is
not done until `npm run verify` passes with clean output.

### Environment file

To run the application, copy the template and fill it in:

```bash
cp .env.example .env
npm run dev
```

Notes for a native run:

- A native run reads `./.env` from the current working directory at startup.
  The application loads the file itself; no shell or tool injects it.
- Values already present in the process environment win over `./.env` values.
- `.env.example` is the short first-run set. Its defaults are relative to the
  checkout: the database, the prompts, and the default policy file resolve
  under the current working directory.
- `FULL_HISTORY` must be set explicitly. `true` imports all reachable history
  for the selected channels. `false` starts with new messages onward.
- Every supported setting, with its default, is listed in
  `config/advanced.env.example`. Copy single lines from there when you need
  them.

## Project layout

| Path | Contents |
| --- | --- |
| `src/` | application source, one directory per subsystem |
| `migrations/` | numbered, immutable SQLite schema migrations |
| `prompts/` | Handlebars prompt templates |
| `config/` | `advanced.env.example` and the default application and policy YAML |
| `test/` | unit, integration, chaos, and eval tests |
| `docs/` | operator documentation, published to GitHub Pages |
| `contributor-docs/` | contributor documentation, GitHub only, outside the docs nav |
| `Dockerfile`, `docker/`, `docker-compose*.yml` | the one image and the Compose contract |

For what each `src/` directory does and how the pieces connect, read
[contributor-docs/architecture.md](contributor-docs/architecture.md). The
operator-level explanation lives in
[docs/explanation/architecture.md](docs/explanation/architecture.md).

## Test discipline

- Test output must be pristine to pass. Do not ignore, filter, or silence a
  warning or failure. When logs are supposed to contain errors, the tests
  capture and assert on them.
- A bugfix starts with a failing test that reproduces the bug. Write it, watch
  it fail, then fix the code.
- Never weaken a privacy test. The privacy matrix in spec Section 46.3 is
  mandatory. If a change and a Section 46.3 assertion disagree, the change is
  wrong, or the specification gets amended first. Packaging and refactoring
  work never weakens these assertions.
- [contributor-docs/acceptance-checklist.md](contributor-docs/acceptance-checklist.md)
  ties every acceptance criterion to a test file and test title. The guard test
  `test/unit/acceptance-citations.test.ts` fails `npm test` when a citation
  drifts. Keep it green when you add, move, or rename tests.

## The specification is the authority

`MNEME_IMPLEMENTATION_SPEC.md` describes what Mneme is. Code and
specification change together:

1. If the specification is wrong or incomplete, amend it in the same pull
   request as the code. The spec records amendments in place, next to the
   section they change.
2. If the code is wrong, fix the code. Do not amend the specification to match
   an accident.
3. Never change one side silently. A reviewer must be able to see both sides of
   the change in one place.

## Database migrations are immutable

A migration file in `migrations/` is frozen once it ships:

- Filenames follow `NNN_name.sql` with three digits and lowercase words.
  Numbers stay contiguous with no gaps.
- The runner stores a SHA-256 checksum of each applied file in
  `schema_migrations`. An edit to an applied file is checksum drift, and
  startup fails.
- To change the schema, add a new numbered file. Never edit, rename, renumber,
  or delete an applied file.
- The comment at the top of a new migration states what the change does and
  cites the spec section it serves.

Migration `005_proposal_dismissal_reason.sql` carries a `task T073` comment
from an earlier task registry. Migrations are immutable, so it stays. No other
file uses that convention. New migrations cite spec sections, not task tokens.

Migrations are forward-only. There is no down path. An upgrade is a deliberate
operator action, and the release process says so.

## How to submit a change

- Keep pull requests small. One change, one pull request.
- Run `npm run verify` before you push. CI runs the same command; a red CI run
  with a green local run means your checkout differs from a clean one.
- Describe what the change does, why the specification allows it, and which
  tests cover it. For a bugfix, name the test that failed first.
- No private data in issues or pull requests. This repository carries no
  content from any real server, and that must stay true. Do not paste Discord or
  Slack tokens, API keys, or message content from any real server. Use synthetic
  data, like the fixture mode does.
