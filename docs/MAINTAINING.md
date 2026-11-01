# Development and releases

The default branch is `main`. Registry releases use package ID `tab-audio-capture`, publisher `hndr` and stable `X.Y.Z` versions. Node behavior and runtime dependencies are separate from the release tooling.

Release tooling is adapted from [Comfyui-SceneDetect](https://github.com/hndrr/Comfyui-SceneDetect).

## Development setup

Use Python 3.12 and Node.js 22 to match CI. From this repository's root, create a development environment:

```bash
python3.12 -m venv .venv
source .venv/bin/activate
python -m pip install torch --index-url https://download.pytorch.org/whl/cpu
python -m pip install -r .github/requirements-test.txt
python -m pytest -q
node --test tests/*.mjs
python -m unittest discover -s .github/tests -v
```

On Windows, activate with `.venv\Scripts\activate`. The tests stub ComfyUI's server and folder paths; a ComfyUI checkout, GPU and browser sharing permissions are not required. HTTP/WebSocket tests need permission to bind localhost sockets.

The tests cover audio formats, output paths, HTTP/WebSocket behavior, pause/resume, Live saves, independent meter cleanup, waveform selection and player updates. GitHub Actions runs these tests on pull requests and pushes to `main`.

Keep the dependency entries in `pyproject.toml` identical to `requirements.txt`. The release tests check this relationship. Development dependencies belong under `.github/`, not in runtime requirements.

To check the actual archive with the publishing CLI:

```bash
python -m pip install -r .github/requirements-release.txt
comfy --skip-prompt --no-enable-telemetry node pack
python .github/scripts/check_package.py node.zip
```

The CLI packs **Git-tracked files**, so stage newly added files before checking the archive locally. `.comfyignore` excludes CI, tests and this guide. Runtime Python, JavaScript, AudioWorklet, example workflows, README, license and all four node screenshots must remain in the package. `node.zip` is ignored by Git.

## One-time GitHub setup

Under **Settings → Secrets and variables → Actions**, add this repository Secret:

| Secret | Value | Used by |
| --- | --- | --- |
| `REGISTRY_ACCESS_TOKEN` | A Comfy Registry publishing API key for publisher `hndr` | Registry publishing and note synchronization |

Create the Registry key using the [Comfy Registry publishing instructions](https://docs.comfy.org/registry/publishing). Verify that `tab-audio-capture` belongs to the intended publisher when making the first release. A conflicting Registry package must be resolved before publishing.

Copilot uses the automatic `GITHUB_TOKEN` with `copilot-requests: write` on the summary-generation job, matching the reference repository. No personal Copilot token or Copilot Secret is required. In this personal repository, usage is billed to the repository owner's Copilot seat and follows its availability and allowance. See [GitHub's authentication and billing documentation](https://docs.github.com/en/copilot/concepts/agent-capabilities/agent-powered-workflows-and-operations/copilot-cli-in-github-actions). Providing the `release_notes` input skips Copilot entirely.

Under **Settings → Actions → General → Workflow permissions**, enable **Allow GitHub Actions to create and approve pull requests**. The workflows declare their own permissions: ordinary CI reads contents; PR preparation writes contents and pull requests; validation reporting writes checks; GitHub Release creation writes contents. No separate GitHub repository PAT is needed for those operations.

## Prepare the first release

Preparation applies the selected version increment even when release history is empty. Merging the tooling setup with an empty history does **not** publish a package.

1. Open **Actions → Prepare release PR → Run workflow** and select `main`.
2. Select the desired `bump`. Starting from `0.1.0`, choose `major` for `1.0.0`, `minor` for `0.2.0`, or `patch` for `0.1.1`. No earlier release tag is required for this first increment.
3. Leave `release_notes` empty for a Copilot summary, or provide a concise English Markdown summary. Copilot summarizes the initial tracked source without requiring an earlier tag.
4. Review the generated release PR. Edit the version's `body` in `.github/release-history.json` to correct the notes; editing only the PR description does not change published notes.
5. Confirm the common CI and **Release preparation validation** check pass, then merge the PR as a maintainer.
6. Watch **Publish to Comfy Registry**. It retests the final release commit, publishes the archive, and creates the matching version tag and GitHub Release with the same summary (`v1.0.0` for the first major release).

The preparation workflow explicitly calls common CI on the PR merge revision and reports the result on its head. If GitHub also presents an approval prompt for bot-created PR workflows, approve it when those separate checks are required by repository rules. Release preparation does not merge its own PR.

## Subsequent releases

Complete the preceding release before preparing another one. Run **Prepare release PR** on `main`, choosing `patch`, `minor` or `major`. The workflow bumps the latest prepared version and summarizes the entire diff since its `vX.Y.Z` tag. It creates or resumes `codex/release/<version>` and never overwrites edits in an existing open PR.

Review the release-history entry and test results before merging. Publication only runs for a prepared history entry. All test jobs resolve one immutable revision; the publishing job checks out the same tested commit. Publishing and note synchronization share one concurrency queue.

Workflows use the `ubuntu-24.04` runner image and Node.js 24-based Actions pinned to full commit SHAs. Copilot CLI is also pinned. Both archive checks and publishing install the same CLI from `.github/requirements-release.txt`; update that file when upgrading. Changes to release tooling should pass the mocked release tests and actual archive check before use.

## Retry and recover

| Failure | Recovery |
| --- | --- |
| Copilot access, allowance, timeout, invalid summary or oversized diff | Run preparation again with a nonempty English `release_notes` input. Generation failure occurs before PR creation. |
| An older run asks for `COPILOT_GITHUB_TOKEN` | After merging the authentication fix, start a new **Prepare release PR** run on `main`. Re-running an old attempt uses its original commit and does not pick up updated workflow or script code. |
| PR preparation interrupted | Run preparation again with the same bump. An open PR is reused. A leftover branch with different changes requires manual review; it is not overwritten. |
| Tests failed | Fix the failure through a PR. Never bypass the test gate. If the prepared release commit itself is broken, prepare a corrected release rather than uploading later code under its version. |
| Registry authentication or upload failed | Correct the Secret or service issue, inspect the Registry version's status and archive, then rerun the failed workflow. Rejected versions or missing/empty archives stop completion for manual review. A version reserved before a failed upload may need Registry-side cleanup before retrying. |
| Registry succeeded but GitHub Release creation failed | Run **Publish to Comfy Registry** on `main` with mode `publish`. Already registered versions skip package upload but still run tests and complete tags/releases. |
| Later commits have landed on `main` | Recovery resolves the original commit that first recorded the version. To recover an older version explicitly, enter that full commit SHA in `release_sha`. It must be on `main` and be the prepared commit. |
| A `vX.Y.Z` tag points to another commit, or the release is a draft/prerelease | Review the conflicting tag/release manually. Automation stops instead of moving tags or replacing releases. |

The workflow logs the selected version, full commit SHA and whether an upload is needed. Retrying after tag creation also reuses that tag. Recovering an older release does not make it the latest release when a newer Registry version exists.

## Synchronize release notes

Edit the published **GitHub Release** description, then run **Publish to Comfy Registry** on `main` with mode `sync-notes`. The GitHub description becomes the source of truth and is copied to the Registry changelog while preserving the version's deprecated flag. This mode never uploads packages or runs Copilot.

Synchronization can also restore missing GitHub Releases for available Registry versions recorded in this repository's history. It uses the original prepared commit and recorded notes when no GitHub Release exists. All target tags and revisions are checked before the first update. Empty descriptions and unrecorded versions require manual review.

## Post-release verification

1. Check that the Registry version and GitHub Release show matching English notes, and that the tag points to the logged release commit. Allow any Registry validation to finish.
2. In a separate ComfyUI installation, run `comfy node install tab-audio-capture`, restart ComfyUI and reload the browser.
3. Load each example workflow. Confirm the main recorder and optional Live node are available and the AudioWorklet loads.
4. Manually record tab playback, stop and preview it, then run the workflow. Check `audio` and the absolute `saved_file_path`. Check Live queue-time snapshots and available output formats. Verify system audio only on a browser/OS combination that supports it.

CI mocks browser sharing dialogs and cannot prove actual browser/OS audio capture support. The README screenshots show the real node controls; update them when those controls change.
