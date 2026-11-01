"""Exercise release recovery with mocked APIs and real temporary Git histories."""

import copy
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import tomllib
import unittest
from unittest.mock import Mock, patch
from urllib.error import HTTPError
import zipfile

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / ".github/scripts"))

import check_package
import generate_release_notes as generate
import prepare_release as prepare
import release_notes as release


SOURCE = '''[project]
name = "tab-audio-capture"
version = "0.1.0"
description = "Capture audio"

[tool.comfy]
PublisherId = "hndr"
'''


class GitRepository(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.old_directory = Path.cwd()
        self.addCleanup(os.chdir, self.old_directory)
        os.chdir(self.temporary.name)
        self.root = Path.cwd()
        self.environment = patch.dict(os.environ, {
            "GIT_AUTHOR_NAME": "Release tests", "GIT_AUTHOR_EMAIL": "tests@example.invalid",
            "GIT_COMMITTER_NAME": "Release tests", "GIT_COMMITTER_EMAIL": "tests@example.invalid",
            "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": os.devnull,
        })
        self.environment.start()
        self.addCleanup(self.environment.stop)
        archive = Mock()
        archive.__enter__ = Mock(return_value=Mock(headers={"Content-Length": "100"}))
        archive.__exit__ = Mock(return_value=False)
        self.archive_request = patch.object(release, "urlopen", return_value=archive)
        self.archive_request.start()
        self.addCleanup(self.archive_request.stop)
        release.git("init", "-q", "--initial-branch=main")
        Path(".github").mkdir()
        Path("pyproject.toml").write_text(SOURCE)
        Path(release.HISTORY_PATH).write_text('{"releases": {}}\n')
        Path("sessions.py").write_text("# Capture audio\n")
        self.commit("Initial files")

    def commit(self, message):
        release.git("add", ".")
        release.git("-c", "commit.gpgsign=false", "commit", "-qm", message)
        sha = release.git("rev-parse", "HEAD")
        release.git("update-ref", "refs/remotes/origin/main", sha)
        return sha

    def record(self, version="0.1.0", body="- Capture playback audio."):
        source = Path("pyproject.toml").read_text()
        current = tomllib.loads(source)["project"]["version"]
        Path("pyproject.toml").write_text(prepare.set_project_version(source, current, version))
        history = self.history()
        history["releases"][version] = {"body": body}
        Path(release.HISTORY_PATH).write_text(json.dumps(history))
        return self.commit(f"Prepare release v{version}")

    def history(self):
        return json.loads(Path(release.HISTORY_PATH).read_text())

    def config(self):
        return tomllib.loads(Path("pyproject.toml").read_text())


class GitHubAPI:
    def __init__(self):
        self.calls = []
        self.tags = {}
        self.releases = []
        self.open_pulls = []
        self.branch = None

    def __call__(self, method, path, data=None, missing_ok=False):
        self.calls.append((method, path, data))
        if method == "GET":
            if "/git/ref/tags/" in path:
                return self.tags.get(path.rsplit("/", 1)[1])
            if "/releases?" in path:
                return self.releases
            if "/pulls?" in path:
                return self.open_pulls
            if "/git/ref/heads/" in path:
                return self.branch
            if "/git/commits/" in path:
                return {"tree": {"sha": "base-tree"}, "sha": path.rsplit("/", 1)[1], "parents": []}
        if method == "POST":
            if path.endswith("/git/trees"):
                return {"sha": "release-tree"}
            if path.endswith("/git/commits"):
                return {"sha": "a" * 40}
            if path.endswith("/git/refs"):
                if data["ref"].startswith("refs/tags/"):
                    self.tags[data["ref"].removeprefix("refs/tags/")] = {"object": {"type": "commit", "sha": data["sha"]}}
                return {}
            if path.endswith("/releases"):
                self.releases.append(copy.deepcopy(data))
                return self.releases[-1]
            if path.endswith("/pulls"):
                pull = {"number": 1, "html_url": "https://github.com/owner/repo/pull/1", "head": {"sha": "a" * 40}}
                self.open_pulls.append(pull)
                return pull
        raise AssertionError((method, path, data))


class RegistryAPI:
    def __init__(self, versions=()):
        self.versions = list(copy.deepcopy(versions))
        self.calls = []

    def __call__(self, method, path, data=None, missing_ok=False):
        self.calls.append((method, path, data))
        if method == "GET":
            return self.versions
        if method == "PUT":
            item = next(item for item in self.versions if path.endswith("/" + item["id"]))
            item.update(data)
            return item
        raise AssertionError((method, path))


def registry_version(version="0.1.0", **updates):
    return {"version": version, "id": version + "-id", "status": "NodeVersionStatusActive",
            "changelog": "- Capture playback audio.", "deprecated": False,
            "downloadUrl": "https://cdn.example.invalid/node.zip", **updates}


class ReleaseTests(GitRepository):
    def preflight(self, github=None, registry=None, requested=""):
        return release.prepare_release(
            github or GitHubAPI(), registry or RegistryAPI(), "owner/repo", self.config(), self.history(), requested,
        )

    def test_empty_history_does_not_publish_or_require_registry(self):
        github, registry = Mock(), Mock()
        self.assertEqual(self.preflight(github, registry), {"release": "false", "upload": "false"})
        github.assert_not_called()
        registry.assert_not_called()

    def test_first_release_has_no_previous_tag(self):
        sha = self.record()
        result = self.preflight()
        self.assertEqual((result["release"], result["upload"], result["sha"], result["version"]), ("true", "true", sha, "0.1.0"))

    def test_merge_commit_is_the_release_revision(self):
        release.git("checkout", "-qb", "codex/release/0.1.0")
        branch_sha = self.record()
        release.git("checkout", "-q", "main")
        Path("later.txt").write_text("Independent main change")
        self.commit("Advance main")
        release.git("-c", "commit.gpgsign=false", "merge", "--no-ff", "-qm", "Merge release PR", "codex/release/0.1.0")
        sha = release.git("rev-parse", "HEAD")
        release.git("update-ref", "refs/remotes/origin/main", sha)
        self.assertNotEqual(sha, branch_sha)
        self.assertEqual(self.preflight()["sha"], sha)

    def test_reserved_version_without_uploaded_archive_cannot_complete(self):
        self.record()
        github, registry = GitHubAPI(), RegistryAPI([registry_version()])
        error = HTTPError("https://cdn.example.invalid/node.zip", 404, "missing", {}, io.BytesIO())
        with patch.object(release, "urlopen", side_effect=error):
            with self.assertRaisesRegex(RuntimeError, "archive is unavailable"):
                release.sync_versions(github, registry, "owner/repo", self.config(), self.history(), "0.1.0")
        self.assertEqual(github.releases, [])
        self.assertTrue(all(method == "GET" for method, _, _ in registry.calls))

    def test_retry_uses_original_release_commit_and_summary(self):
        sha = self.record()
        Path("sessions.py").write_text("# Later changes\n")
        history = self.history()
        history["releases"]["0.1.0"]["body"] = "- Later edited notes."
        Path(release.HISTORY_PATH).write_text(json.dumps(history))
        self.commit("Later changes")
        result = self.preflight()
        self.assertEqual(result["sha"], sha)
        self.assertEqual(result["body"], "- Capture playback audio.")

    def test_explicit_nonrelease_sha_is_rejected(self):
        self.record()
        Path("sessions.py").write_text("# More changes\n")
        later = self.commit("Later change")
        with self.assertRaisesRegex(ValueError, "prepared release commit"):
            self.preflight(requested=later)

    def test_existing_version_skips_upload_but_completes_release(self):
        sha = self.record()
        github, registry = GitHubAPI(), RegistryAPI([registry_version()])
        result = self.preflight(github, registry)
        self.assertEqual((result["release"], result["upload"]), ("true", "false"))
        release.sync_versions(github, registry, "owner/repo", self.config(), self.history(), "0.1.0")
        self.assertEqual(github.releases[0]["target_commitish"], sha)
        self.assertEqual(github.releases[0]["body"], result["body"])
        self.assertTrue(all(method == "GET" for method, _, _ in registry.calls))

    def test_resume_after_tag_creation_without_duplicate_tag(self):
        sha = self.record()
        github, registry = GitHubAPI(), RegistryAPI([registry_version()])
        github.tags["v0.1.0"] = {"object": {"type": "commit", "sha": sha}}
        release.sync_versions(github, registry, "owner/repo", self.config(), self.history(), "0.1.0")
        self.assertEqual(len(github.releases), 1)
        self.assertFalse(any(method == "POST" and path.endswith("/git/refs") for method, path, _ in github.calls))

    def test_repeated_completion_is_idempotent(self):
        self.record()
        github, registry = GitHubAPI(), RegistryAPI([registry_version()])
        for _ in range(2):
            release.sync_versions(github, registry, "owner/repo", self.config(), self.history(), "0.1.0")
        self.assertEqual(len(github.releases), 1)

    def test_tag_conflict_stops_before_registry_changes(self):
        self.record()
        github, registry = GitHubAPI(), RegistryAPI([registry_version(changelog="outdated")])
        github.tags["v0.1.0"] = {"object": {"type": "commit", "sha": "f" * 40}}
        with self.assertRaisesRegex(ValueError, "does not point"):
            self.preflight(github, registry)
        self.assertEqual(registry.calls, [])
        with self.assertRaisesRegex(ValueError, "does not point"):
            release.sync_versions(github, registry, "owner/repo", self.config(), self.history())
        self.assertTrue(all(method == "GET" for method, _, _ in registry.calls))

    def test_edited_github_notes_are_shared_and_deprecation_preserved(self):
        sha = self.record()
        github, registry = GitHubAPI(), RegistryAPI([registry_version(deprecated=True)])
        github.tags["v0.1.0"] = {"object": {"type": "commit", "sha": sha}}
        github.releases = [{"tag_name": "v0.1.0", "body": "- Edited English notes.", "draft": False, "prerelease": False}]
        release.sync_versions(github, registry, "owner/repo", self.config(), self.history())
        self.assertEqual(registry.versions[0]["changelog"], "- Edited English notes.")
        self.assertTrue(registry.versions[0]["deprecated"])
        self.assertEqual(len(github.releases), 1)

    def test_new_release_must_be_newer_than_registry(self):
        self.record()
        with self.assertRaisesRegex(ValueError, "newer"):
            self.preflight(registry=RegistryAPI([registry_version("0.2.0")]))

    def test_rejected_registry_version_cannot_be_reused(self):
        self.record()
        with self.assertRaisesRegex(ValueError, "not available"):
            self.preflight(registry=RegistryAPI([registry_version(status="NodeVersionStatusBanned")]))

    def test_no_github_release_before_registry_version_exists(self):
        self.record()
        github = GitHubAPI()
        with self.assertRaisesRegex(ValueError, "not available"):
            release.sync_versions(github, RegistryAPI(), "owner/repo", self.config(), self.history(), "0.1.0")
        self.assertEqual(github.releases, [])

    def test_sync_checks_all_tags_before_writing_any_notes(self):
        first = self.record()
        self.record("0.2.0", "- Add features.")
        github, registry = GitHubAPI(), RegistryAPI([registry_version(changelog="old"), registry_version("0.2.0", changelog="old")])
        github.tags["v0.1.0"] = {"object": {"type": "commit", "sha": first}}
        github.tags["v0.2.0"] = {"object": {"type": "commit", "sha": "f" * 40}}
        with self.assertRaisesRegex(ValueError, "does not point"):
            release.sync_versions(github, registry, "owner/repo", self.config(), self.history())
        self.assertTrue(all(method == "GET" for method, _, _ in registry.calls))


class PrepareTests(GitRepository):
    def test_initial_release_keeps_configured_version(self):
        for bump in ("patch", "minor", "major"):
            self.assertEqual(prepare.next_version("0.1.0", self.history(), bump), "0.1.0")

    def test_version_increments(self):
        sha = self.record()
        release.git("tag", "v0.1.0", sha)
        for bump, expected in (("patch", "0.1.1"), ("minor", "0.2.0"), ("major", "1.0.0")):
            with self.subTest(bump=bump):
                self.assertEqual(prepare.next_version("0.1.0", self.history(), bump), expected)

    def test_next_release_requires_previous_tag(self):
        self.record()
        with self.assertRaisesRegex(ValueError, "Complete release"):
            prepare.next_version("0.1.0", self.history(), "patch")

    def test_tag_without_completed_github_release_blocks_next_pr(self):
        sha = self.record()
        release.git("tag", "v0.1.0", sha)
        github = GitHubAPI()
        with self.assertRaisesRegex(ValueError, "Complete the GitHub Release"):
            prepare.prepare_pull_request(github, "owner/repo", sha, Path("pyproject.toml").read_text(), json.dumps(self.history()), "patch", "- Next release.")
        self.assertEqual(github.open_pulls, [])

    def test_retry_resumes_matching_orphaned_branch(self):
        sha = release.git("rev-parse", "HEAD")
        github = GitHubAPI()
        github.branch = {"object": {"sha": "f" * 40}}
        def resume(method, path, data=None, missing_ok=False):
            if path.endswith("/git/commits/" + "f" * 40):
                return {"tree": {"sha": "release-tree"}, "parents": [{"sha": sha}]}
            return github(method, path, data, missing_ok)
        pull = prepare.prepare_pull_request(resume, "owner/repo", sha, SOURCE, json.dumps(self.history()), "patch", "- Capture audio.")
        self.assertEqual(pull["number"], 1)
        self.assertFalse(any(method == "POST" and path.endswith("/git/refs") for method, path, _ in github.calls))

    def test_only_project_version_is_updated(self):
        source = SOURCE + '\n[tool.example]\nversion = "0.1.0"\n'
        result = tomllib.loads(prepare.set_project_version(source, "0.1.0", "0.1.1"))
        self.assertEqual(result["project"]["version"], "0.1.1")
        self.assertEqual(result["tool"]["example"]["version"], "0.1.0")

    def test_pr_contains_shared_notes_and_correct_branch(self):
        github = GitHubAPI()
        prepare.prepare_pull_request(github, "owner/repo", release.git("rev-parse", "HEAD"), SOURCE, json.dumps(self.history()), "patch", "- New capture nodes.")
        tree = next(data for method, path, data in github.calls if method == "POST" and path.endswith("/git/trees"))
        history = json.loads(next(item["content"] for item in tree["tree"] if item["path"] == release.HISTORY_PATH))
        self.assertEqual(history["releases"]["0.1.0"]["body"], "- New capture nodes.")
        pull = next(data for method, path, data in github.calls if method == "POST" and path.endswith("/pulls"))
        self.assertEqual((pull["base"], pull["head"]), ("main", "codex/release/0.1.0"))

    def test_retry_reuses_open_pr_without_overwriting_edits(self):
        github = GitHubAPI()
        arguments = (github, "owner/repo", release.git("rev-parse", "HEAD"), SOURCE, json.dumps(self.history()), "patch", "- Audio capture.")
        first = prepare.prepare_pull_request(*arguments)
        github.calls.clear()
        self.assertEqual(prepare.prepare_pull_request(*arguments), first)
        self.assertTrue(all(method == "GET" for method, _, _ in github.calls))

    def test_existing_branch_with_different_changes_is_not_overwritten(self):
        github = GitHubAPI()
        github.branch = {"object": {"sha": "f" * 40}}
        with self.assertRaisesRegex(ValueError, "different changes"):
            prepare.prepare_pull_request(github, "owner/repo", release.git("rev-parse", "HEAD"), SOURCE, json.dumps(self.history()), "patch", "- Audio capture.")
        self.assertEqual(github.open_pulls, [])

    def test_empty_summary_does_not_create_pr(self):
        github = Mock()
        with self.assertRaisesRegex(ValueError, "summary"):
            prepare.prepare_pull_request(github, "owner/repo", release.git("rev-parse", "HEAD"), SOURCE, json.dumps(self.history()), "patch", " ")
        github.assert_not_called()


class GenerationTests(GitRepository):
    def test_initial_prompt_does_not_need_a_release_tag(self):
        prompt = generate.release_prompt()
        self.assertIn('"previous_release": "initial release"', prompt)
        self.assertIn("Capture audio", prompt)

    def test_prompt_uses_full_diff_since_release(self):
        sha = self.record()
        release.git("tag", "v0.1.0", sha)
        Path("sessions.py").write_text("# Improve output audio\n")
        self.commit("Improve audio")
        prompt = generate.release_prompt()
        self.assertIn('"previous_release": "v0.1.0"', prompt)
        self.assertIn("Improve output audio", prompt)

    def test_no_changes_refuses_automatic_notes(self):
        sha = self.record()
        release.git("tag", "v0.1.0", sha)
        with self.assertRaisesRegex(ValueError, "No changes"):
            generate.release_prompt()

    def test_oversized_diff_requests_manual_summary(self):
        Path("sessions.py").write_text("x" * 200000)
        self.commit("Large source change")
        with self.assertRaisesRegex(ValueError, "too large"):
            generate.release_prompt()

    def test_manual_summary_bypasses_copilot_and_git(self):
        with tempfile.NamedTemporaryFile() as output, patch.dict(os.environ, {"RELEASE_NOTES_INPUT": "- Manual notes.", "GITHUB_OUTPUT": output.name}), patch.object(generate, "generate_summary") as copilot, patch.object(generate, "release_prompt") as prompt:
            generate.main()
            self.assertIn("- Manual notes.", Path(output.name).read_text())
            copilot.assert_not_called()
            prompt.assert_not_called()

    def test_copilot_failure_does_not_produce_notes(self):
        with patch.dict(os.environ, {"COPILOT_GITHUB_TOKEN": "private-test-token"}), patch.object(generate.subprocess, "run", side_effect=subprocess.CalledProcessError(1, "copilot", stderr="private-test-token")):
            with self.assertRaisesRegex(RuntimeError, "No release PR") as error:
                generate.generate_summary("diff")
            self.assertNotIn("private-test-token", str(error.exception))

    def test_generated_notes_are_validated(self):
        for body in ("", "Text without bullets", "- See https://example.com", "- Thanks @author", "- 日本語", "- One\n- Two\n- Three\n- Four"):
            with self.subTest(body=body), patch.dict(os.environ, {"COPILOT_GITHUB_TOKEN": "test"}), patch.object(generate.subprocess, "run", return_value=Mock(stdout=body)):
                with self.assertRaises(ValueError):
                    generate.generate_summary("diff")

    def test_copilot_runs_without_tools_outside_repository(self):
        with patch.dict(os.environ, {"COPILOT_GITHUB_TOKEN": "test"}), patch.object(generate.subprocess, "run", return_value=Mock(stdout="- Improve audio capture.\n")) as run:
            self.assertEqual(generate.generate_summary("diff"), "- Improve audio capture.")
            self.assertIn("--deny-tool=write", run.call_args.args[0])
            self.assertIn("--disable-builtin-mcps", run.call_args.args[0])
            self.assertNotEqual(Path(run.call_args.kwargs["cwd"]), self.root)

    def test_large_prompt_reaches_copilot_through_stdin(self):
        prompt = "Release changes:\n" + "é" * 70000
        with tempfile.TemporaryDirectory() as directory:
            executable = Path(directory) / "copilot"
            executable.write_text(
                f"#!{sys.executable}\n"
                "import sys\n"
                "assert '--prompt' not in sys.argv\n"
                f"assert len(sys.stdin.read().encode('utf-8')) == {len(prompt.encode('utf-8'))}\n"
                "print('- Capture playback audio.')\n"
            )
            executable.chmod(0o755)
            with patch.dict(os.environ, {"COPILOT_GITHUB_TOKEN": "test", "PATH": directory + os.pathsep + os.environ["PATH"]}):
                self.assertEqual(generate.generate_summary(prompt), "- Capture playback audio.")


class ContractTests(unittest.TestCase):
    def test_failed_common_ci_is_reported_as_failure(self):
        github = Mock()
        env = {"GITHUB_REPOSITORY": "owner/repo", "GH_TOKEN": "test", "RELEASE_HEAD_SHA": "a" * 40,
               "TEST_RESULT": "failure", "GITHUB_SERVER_URL": "https://github.com", "GITHUB_RUN_ID": "42"}
        with patch.dict(os.environ, env), patch.object(release, "API", return_value=github), patch.object(sys, "argv", ["release_notes.py", "report"]):
            with self.assertRaisesRegex(SystemExit, "did not succeed"):
                release.main()
        self.assertEqual(github.call_args.args[2]["conclusion"], "failure")
        self.assertEqual(github.call_args.args[2]["head_sha"], "a" * 40)

    def test_metadata_dependencies_equal_runtime_requirements(self):
        metadata = tomllib.loads((ROOT / "pyproject.toml").read_text())
        requirements = (ROOT / "requirements.txt").read_text().splitlines()
        self.assertEqual(metadata["project"]["dependencies"], requirements)
        self.assertEqual(metadata["tool"]["comfy"]["PublisherId"], "hndr")
        self.assertEqual(metadata["project"]["name"], "tab-audio-capture")
        self.assertTrue((ROOT / metadata["project"]["license"]["file"]).is_file())

    def test_api_only_treats_404_as_missing_and_does_not_log_credentials(self):
        for status in (404, 401, 500):
            error = HTTPError("https://api.example.invalid", status, "failure", {}, io.BytesIO(b"secret-token"))
            with self.subTest(status=status), patch.object(release, "urlopen", side_effect=error):
                api = release.API("https://api.example.invalid", "secret-token")
                if status == 404:
                    self.assertIsNone(api("GET", "/versions", missing_ok=True))
                else:
                    with self.assertRaises(RuntimeError) as raised:
                        api("GET", "/versions", missing_ok=True)
                    self.assertNotIn("secret-token", str(raised.exception))

    def test_workflow_outputs_safely_preserve_multiline_text(self):
        with tempfile.NamedTemporaryFile() as output:
            release.write_outputs(output.name, {"body": "- One\nEOF\nbody=unexpected\n- Two"})
            lines = Path(output.name).read_text().splitlines()
            delimiter = lines[0].split("<<", 1)[1]
            self.assertEqual(lines[-1], delimiter)
            self.assertEqual("\n".join(lines[1:-1]), "- One\nEOF\nbody=unexpected\n- Two")

    def test_package_checker_rejects_missing_worklet_and_development_files(self):
        with tempfile.NamedTemporaryFile(suffix=".zip") as output:
            with zipfile.ZipFile(output.name, "w") as archive:
                archive.writestr("__init__.py", "")
                archive.writestr(".github/release-history.json", "{}")
            with self.assertRaisesRegex(ValueError, "web/worklets/tab_audio_worklet.mjs"):
                check_package.check_package(output.name)


if __name__ == "__main__":
    unittest.main()
