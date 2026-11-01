"""Create or resume a release PR without changing the default branch."""

import argparse
import json
import os
from pathlib import Path
import re
import tomllib
from urllib.parse import quote

from release_notes import API, HISTORY_PATH, existing_release, git, previous_release_sha, version_tuple, write_outputs


def set_project_version(source, current, version):
    project = re.search(r"(?ms)^\[project\][^\n]*\n.*?(?=^\[|\Z)", source)
    if project is None:
        raise ValueError("Expected a [project] section")
    updated, count = re.subn(
        rf'''(?m)^([ \t]*version[ \t]*=[ \t]*)(["']){re.escape(current)}\2''',
        lambda match: f"{match[1]}{match[2]}{version}{match[2]}", project[0],
    )
    if count != 1:
        raise ValueError("Expected one project.version assignment")
    return source[:project.start()] + updated + source[project.end():]


def next_version(current, history, bump):
    major, minor, patch = version_tuple(current)
    if not history["releases"]:
        return current
    if max(history["releases"], key=version_tuple) != current:
        raise ValueError("project.version must match the latest prepared release")
    previous_release_sha(current)
    return {"patch": f"{major}.{minor}.{patch + 1}", "minor": f"{major}.{minor + 1}.0", "major": f"{major + 1}.0.0"}[bump]


def prepare_pull_request(github, repository, sha, source, history_source, bump, body):
    current = tomllib.loads(source)["project"]["version"]
    history = json.loads(history_source)
    version = next_version(current, history, bump)
    if history["releases"] and existing_release(github, repository, current) is None:
        raise ValueError(f"Complete the GitHub Release for v{current} before preparing the next release")
    body = body.strip()
    if not body:
        raise ValueError("An English release summary is required")
    branch = f"codex/release/{version}"
    prefix = f"/repos/{repository}"
    head = quote(f"{repository.split('/')[0]}:{branch}", safe="")
    existing = github("GET", f"{prefix}/pulls?state=open&base=main&head={head}")
    if existing:
        return existing[0]
    source = set_project_version(source, current, version)
    history["releases"][version] = {"body": body}
    parent = github("GET", f"{prefix}/git/commits/{sha}")
    tree = github("POST", f"{prefix}/git/trees", {
        "base_tree": parent["tree"]["sha"],
        "tree": [
            {"path": "pyproject.toml", "mode": "100644", "type": "blob", "content": source},
            {"path": HISTORY_PATH, "mode": "100644", "type": "blob", "content": json.dumps(history, ensure_ascii=False, indent=2) + "\n"},
        ],
    })
    ref = github("GET", f"{prefix}/git/ref/heads/{branch}", missing_ok=True)
    if ref is not None:
        commit = github("GET", f"{prefix}/git/commits/{ref['object']['sha']}")
        if commit["tree"]["sha"] != tree["sha"] or [item["sha"] for item in commit["parents"]] != [sha]:
            raise ValueError(f"Branch {branch} already has different changes; review it before retrying")
    else:
        commit = github("POST", f"{prefix}/git/commits", {
            "message": f"Prepare release v{version}", "tree": tree["sha"], "parents": [sha],
        })
        github("POST", f"{prefix}/git/refs", {"ref": f"refs/heads/{branch}", "sha": commit["sha"]})
    return github("POST", f"{prefix}/pulls", {
        "title": f"Release v{version}", "head": branch, "base": "main",
        "body": f"{body}\n\nReview the summary in `{HISTORY_PATH}`. Merging this PR publishes v{version} after all tests pass.",
    })


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bump", choices=("patch", "minor", "major"), default="patch")
    arguments = parser.parse_args()
    github = API(os.environ.get("GITHUB_API_URL", "https://api.github.com"), os.environ["GH_TOKEN"])
    pull = prepare_pull_request(
        github, os.environ["GITHUB_REPOSITORY"], git("rev-parse", "HEAD"),
        Path("pyproject.toml").read_text(encoding="utf-8"), Path(HISTORY_PATH).read_text(encoding="utf-8"),
        arguments.bump, os.environ["RELEASE_NOTES_INPUT"],
    )
    write_outputs(os.environ["GITHUB_OUTPUT"], {"pull_number": str(pull["number"]), "head_sha": pull["head"]["sha"]})
    with Path(os.environ["GITHUB_STEP_SUMMARY"]).open("a", encoding="utf-8") as output:
        output.write(f"Release preparation PR: {pull['html_url']}\n")
    print(pull["html_url"])


if __name__ == "__main__":
    main()
