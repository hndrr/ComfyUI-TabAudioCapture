"""Publish prepared revisions and share notes between Registry and GitHub Releases.

Adapted from hndrr/Comfyui-SceneDetect's MIT-licensed release tooling.
"""

import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import tomllib
from urllib.error import HTTPError
from urllib.parse import quote
from urllib.request import Request, urlopen
import uuid


HISTORY_PATH = ".github/release-history.json"


class API:
    def __init__(self, base_url, token):
        if not token:
            raise ValueError("An API token is required; configure the workflow Secret")
        self.base_url = base_url.rstrip("/")
        self.headers = {
            "Accept": "application/json", "Content-Type": "application/json",
            "Authorization": f"Bearer {token}",
        }

    def __call__(self, method, path, data=None, missing_ok=False):
        payload = None if data is None else json.dumps(data).encode("utf-8")
        request = Request(self.base_url + path, data=payload, headers=self.headers, method=method)
        try:
            with urlopen(request, timeout=30) as response:
                return json.load(response)
        except HTTPError as error:
            status = error.code
            error.close()
            if missing_ok and status == 404:
                return None
            # An API response can echo credentials; never include its body.
            raise RuntimeError(f"{method} {path}: HTTP {status}") from None


def git(*arguments):
    return subprocess.check_output(["git", *arguments], text=True).strip()


def version_tuple(version):
    if not re.fullmatch(r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)", version):
        raise ValueError(f"Expected a stable X.Y.Z version: {version}")
    return tuple(map(int, version.split(".")))


def validate_sha(sha):
    if not re.fullmatch(r"[0-9a-f]{40}|[0-9a-f]{64}", sha) or not sha.strip("0"):
        raise ValueError("A full SHA-1 or SHA-256 commit ID is required")


def checked_tag(github, repository, version, sha):
    version_tuple(version)
    validate_sha(sha)
    prefix = f"/repos/{repository}"
    ref = github("GET", f"{prefix}/git/ref/tags/v{version}", missing_ok=True)
    if ref is None:
        return None
    target = ref["object"]
    visited = set()
    while target["type"] == "tag":
        if target["sha"] in visited:
            raise ValueError("Cyclic annotated tag")
        visited.add(target["sha"])
        target = github("GET", f"{prefix}/git/tags/{target['sha']}")["object"]
    if target["type"] != "commit" or target["sha"] != sha:
        raise ValueError(f"Tag v{version} does not point to the prepared commit {sha}")
    return ref


def existing_release(github, repository, version):
    page = 1
    while True:
        releases = github("GET", f"/repos/{repository}/releases?per_page=100&page={page}")
        for release in releases:
            if release["tag_name"] == f"v{version}":
                if release["draft"] or release["prerelease"]:
                    raise ValueError(f"Release v{version} is a draft or prerelease; review it explicitly")
                return release
        if len(releases) < 100:
            return None
        page += 1


def release_commit(version):
    """Use the first main commit recording this version, even on a later retry."""
    version_tuple(version)
    revisions = git("log", "--first-parent", "--reverse", "--format=%H", "--", HISTORY_PATH).splitlines()
    for sha in revisions:
        history = json.loads(git("show", f"{sha}:{HISTORY_PATH}"))["releases"]
        if version in history:
            config = tomllib.loads(git("show", f"{sha}:pyproject.toml"))
            if config["project"]["version"] != version:
                raise ValueError(f"The first history entry for {version} has a different project version")
            return sha
    raise ValueError(f"No prepared release commit is recorded for {version}")


def registered_versions(registry, node_id):
    return registry("GET", f"/nodes/{quote(node_id, safe='')}/versions", missing_ok=True) or []


def verify_uploaded_archive(node_version):
    url = node_version.get("downloadUrl", "")
    if not url.startswith("https://"):
        raise ValueError("Registry has no package download URL; inspect the upload before retrying")
    try:
        with urlopen(Request(url, method="HEAD"), timeout=30) as response:
            if int(response.headers.get("Content-Length", "0")) <= 0:
                raise ValueError("Registry archive is empty; inspect the upload before retrying")
    except HTTPError as error:
        status = error.code
        error.close()
        raise RuntimeError(f"Registry archive is unavailable (HTTP {status}); inspect the upload before retrying") from None


def previous_release_sha(version):
    try:
        sha = git("rev-parse", "--verify", "--quiet", f"refs/tags/v{version}^{{commit}}")
        git("merge-base", "--is-ancestor", sha, "HEAD")
    except subprocess.CalledProcessError:
        raise ValueError(f"Complete release v{version} before preparing the next release") from None
    if sha != release_commit(version):
        raise ValueError(f"Tag v{version} does not point to its prepared release commit")
    return sha


def prepare_release(github, registry, repository, config, history, requested_sha=""):
    version = config["project"]["version"]
    version_tuple(version)
    if version not in history["releases"]:
        return {"release": "false", "upload": "false"}
    sha = release_commit(version)
    validate_sha(sha)
    if requested_sha:
        validate_sha(requested_sha)
        if requested_sha != sha:
            raise ValueError(f"release_sha must be the prepared release commit {sha}")
    git("merge-base", "--is-ancestor", sha, "origin/main")
    prepared_config = tomllib.loads(git("show", f"{sha}:pyproject.toml"))
    prepared_history = json.loads(git("show", f"{sha}:{HISTORY_PATH}"))["releases"]
    body = prepared_history[version]["body"].strip()
    if not body:
        raise ValueError("The prepared release summary must not be empty")
    if max(prepared_history, key=version_tuple) != version:
        raise ValueError("A release must be newer than its recorded predecessors")
    ref = checked_tag(github, repository, version, sha)
    release = existing_release(github, repository, version)
    if release is not None and ref is None:
        raise ValueError(f"Release v{version} has no matching tag")
    versions = registered_versions(registry, prepared_config["project"]["name"])
    matches = [item for item in versions if item["version"] == version]
    if len(matches) > 1:
        raise ValueError(f"Registry returned duplicate versions for {version}")
    if matches and matches[0]["status"] not in ("NodeVersionStatusActive", "NodeVersionStatusPending"):
        raise ValueError(f"Registry version {version} is not available; review its status before retrying")
    if matches:
        verify_uploaded_archive(matches[0])
    if not matches and versions and version_tuple(version) <= max(version_tuple(item["version"]) for item in versions):
        raise ValueError("The release version must be newer than existing Registry versions")
    return {
        "release": "true", "upload": "false" if matches else "true",
        "sha": sha, "version": version, "body": body,
    }


def release_target(github, repository, version, sha, fallback):
    ref = checked_tag(github, repository, version, sha)
    release = existing_release(github, repository, version)
    if release is not None and ref is None:
        raise ValueError(f"Release v{version} has no matching tag")
    body = ((release.get("body") or "") if release is not None else fallback).strip()
    if not body:
        raise ValueError(f"Release notes for {version} must not be empty")
    return ref, release, body


def sync_release(github, registry, repository, publisher, node_id, node_version, sha, fallback, latest=True):
    version = node_version["version"]
    ref, release, body = release_target(github, repository, version, sha, fallback)
    if (node_version.get("changelog") or "").strip() != body:
        updated = registry("PUT", (
            f"/publishers/{quote(publisher, safe='')}/nodes/{quote(node_id, safe='')}"
            f"/versions/{quote(node_version['id'], safe='')}"
        ), {"changelog": body, "deprecated": node_version.get("deprecated", False)})
        if (updated.get("changelog") or "").strip() != body:
            raise ValueError(f"Registry did not retain the changelog for {version}")
        if updated.get("deprecated", False) != node_version.get("deprecated", False):
            raise ValueError(f"Registry did not preserve the deprecated status for {version}")
    prefix = f"/repos/{repository}"
    if release is None:
        if ref is None:
            github("POST", f"{prefix}/git/refs", {"ref": f"refs/tags/v{version}", "sha": sha})
        github("POST", f"{prefix}/releases", {
            "tag_name": f"v{version}", "target_commitish": sha, "name": f"v{version}",
            "body": body, "draft": False, "prerelease": False,
            "make_latest": "true" if latest else "false",
        })
    print(f"Release v{version} and Registry notes are synchronized at {sha}")


def sync_versions(github, registry, repository, config, history, version=None):
    publisher = config["tool"]["comfy"]["PublisherId"]
    node_id = config["project"]["name"]
    versions = registered_versions(registry, node_id)
    available = [item for item in versions if item["status"] in ("NodeVersionStatusActive", "NodeVersionStatusPending")]
    targets = available if version is None else [item for item in available if item["version"] == version]
    if version is not None and len(targets) != 1:
        raise ValueError(f"Registry version {version} is not available for release completion")
    latest = max((item["version"] for item in available), key=version_tuple, default=None)
    resolved = []
    for item in sorted(targets, key=lambda value: version_tuple(value["version"])):
        value = item["version"]
        verify_uploaded_archive(item)
        sha = release_commit(value)
        git("merge-base", "--is-ancestor", sha, "origin/main")
        body = history["releases"][value]["body"]
        release_target(github, repository, value, sha, body)
        resolved.append((item, sha, body))
    # Check every revision and tag before making the first change.
    for item, sha, body in resolved:
        sync_release(github, registry, repository, publisher, node_id, item, sha, body, latest=item["version"] == latest)


def write_outputs(path, values):
    with Path(path).open("a", encoding="utf-8") as output:
        for name, value in values.items():
            delimiter = f"release_{uuid.uuid4().hex}"
            while delimiter in value.splitlines():
                delimiter = f"release_{uuid.uuid4().hex}"
            output.write(f"{name}<<{delimiter}\n{value}\n{delimiter}\n")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("prepare", "create", "sync", "report"))
    arguments = parser.parse_args()
    repository = os.environ["GITHUB_REPOSITORY"]
    github = API(os.environ.get("GITHUB_API_URL", "https://api.github.com"), os.environ["GH_TOKEN"])
    if arguments.mode == "report":
        sha = os.environ["RELEASE_HEAD_SHA"]
        validate_sha(sha)
        result = os.environ["TEST_RESULT"]
        conclusion = result if result in ("success", "cancelled") else "failure"
        github("POST", f"/repos/{repository}/check-runs", {
            "name": "Release preparation validation", "head_sha": sha,
            "status": "completed", "conclusion": conclusion,
            "details_url": f"{os.environ['GITHUB_SERVER_URL']}/{repository}/actions/runs/{os.environ['GITHUB_RUN_ID']}",
            "output": {"title": f"Release preparation CI: {result}", "summary": "Review the English summary and all tests before merging."},
        })
        if conclusion != "success":
            raise SystemExit("Release preparation CI did not succeed")
        return
    config = tomllib.loads(Path("pyproject.toml").read_text(encoding="utf-8"))
    history = json.loads(Path(HISTORY_PATH).read_text(encoding="utf-8"))
    if arguments.mode == "prepare" and config["project"]["version"] not in history["releases"]:
        write_outputs(os.environ["GITHUB_OUTPUT"], {"release": "false", "upload": "false"})
        return
    registry = API("https://api.comfy.org", os.environ["REGISTRY_ACCESS_TOKEN"])
    if arguments.mode == "prepare":
        outputs = prepare_release(github, registry, repository, config, history, os.environ.get("RELEASE_SHA_INPUT", ""))
        write_outputs(os.environ["GITHUB_OUTPUT"], outputs)
        if outputs["release"] == "true":
            print(f"Prepared v{outputs['version']} at {outputs['sha']}; upload={outputs['upload']}")
    else:
        version = os.environ["RELEASE_VERSION"] if arguments.mode == "create" else None
        if version is not None and git("rev-parse", "HEAD") != os.environ["RELEASE_SHA"]:
            raise ValueError("Release completion must check out the tested commit")
        sync_versions(github, registry, repository, config, history, version)


if __name__ == "__main__":
    main()
