# Release process

This document describes how a Mneme release is cut, from the tag to the
operator checks. The publishing workflow is
[.github/workflows/release.yml](../.github/workflows/release.yml). Its
publication contract is spec Section 38.7.

Status at the time of writing: **no release has been published yet.** See
[First live run](#first-live-run) for the recorded baseline of v1.0.0.

## Before you tag

1. Set the version in `package.json`. The tag and the package version must
   match: tag `vX.Y.Z` needs `"version": "X.Y.Z"`. The workflow checks this and
   fails on a mismatch.
2. Verify from a clean checkout, not your working tree:

   ```bash
   git clone https://github.com/steel-experiments/mneme.git
   cd mneme
   git checkout <commit-to-release>
   npm ci --ignore-scripts
   npm run verify
   docker build -t mneme:release-check .
   ```

3. Update `CHANGELOG.md`. The `Unreleased` entry becomes the version heading,
   with the release date set at launch. Add nothing you cannot verify.

## Tag and push

```bash
git tag vX.Y.Z
git push origin vX.Y.Z
```

Only a tag push starts the workflow. The tag filter accepts stable versions
only, `vMAJOR.MINOR.PATCH`. A suffix such as `v1.2.3-rc1` does not publish and
does not move `latest`.

## What the workflow does

No manual steps run here. The workflow:

1. Builds the image for linux/amd64 and linux/arm64, each on a native runner.
2. Runs the offline fixture smoke test on each architecture
   (`docker run --rm --network none <image> node dist/fixture-mode.js`) before
   anything is pushed. The publish job runs only after both verify jobs pass.
3. Pushes one multi-arch image as the version tag and as `latest`, with the
   source revision recorded inside the image. This is a second build from the
   same inputs. It reuses the smoke-tested layers through the per-architecture
   GitHub Actions build cache, but the cache is best-effort: a cache miss
   rebuilds a layer from the same source, so the pushed bytes are not
   guaranteed to be identical to the images the verify jobs ran.
4. Writes the digest summary to the job log.
5. Creates a **draft** GitHub release that carries the digest, the version tag,
   and the verified architectures. A human publishes the draft. No workflow
   step publishes it.

## After the workflow: the human steps

1. Open the draft release on GitHub. Check the digest line:
   `ghcr.io/steel-experiments/mneme@sha256:<digest>`. Publish the
   release. The release notes carry the digest of the published tag; that is
   the reference operators pin.
2. Update the install documentation when it pins concrete versions. The docs
   keep `vX.Y.Z` placeholders by design, so usually nothing changes; check
   [docs/how-to/deploy.md](../docs/how-to/deploy.md) and
   `docker-compose.image.example.yml` for any hard-coded tag or digest that
   must move forward.
3. Verify a fresh install path with the released image, not a local build:
   follow [docs/how-to/deploy.md](../docs/how-to/deploy.md) from the digest pin
   onward, then the first-use verification in
   [Verify your first answer](../docs/tutorials/getting-started.md#8-verify-your-first-answer). Confirm `/livez`
   and `/readyz` answer, and that the container healthcheck passes.
4. Treat upgrades as deliberate. Migrations are forward-only, `latest` is a
   convenience pointer, and the operator contract is stop-and-start, never an
   overlapping rolling replacement.

## First live run

The v1.0.0 tag on 2026-09-16 exercised this process end to end:

- Workflow run 35117498306: verify on linux/amd64 and linux/arm64, the
  multi-arch push, the digest summary, and the draft release all passed.
- The published manifest digest is
  `sha256:87c5fc4ce070edcfad3ebc5008795cd5185b387e6e5363c9024b3c0b43e34309`,
  built from tagged commit `fcbf92b`; the revision label is baked into the
  image and appears in the startup log of a running deployment.
- The released image ran live on Railway (digest-pinned service source,
  deployment 4e9bd17c) with an existing volume, and the Railway backup drill
  passed against it.
- The Railway template publishes from that digest-pinned service:
  <https://railway.com/template/cassandra-for-discord>.

Treat older history below this section as procedure only. Items that remain
unverified after v1.0.0: none known.
