"""Release: bump version, test, build, zip, commit, tag, push, GitHub release.

Usage: python publish.py [patch|minor|major]   (default: patch)

The zip holds the built app (dist/, dist-server/) plus package files; on the
target machine run `npm ci --omit=dev` then `node dist-server/src/server/main.js`.
"""
import json
import os
import subprocess
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent
NPM = "npm.cmd" if os.name == "nt" else "npm"
SHIP = ["dist", "dist-server", "package.json", "package-lock.json", "README.md"]


def run(*args: str, capture: bool = False) -> str:
    result = subprocess.run(list(args), cwd=ROOT, check=True, text=True, capture_output=capture)
    return result.stdout.strip() if capture else ""


def fail(msg: str) -> int:
    print(f"publish: {msg}", file=sys.stderr)
    return 1


def main() -> int:
    level = sys.argv[1] if len(sys.argv) > 1 else "patch"
    if level not in ("patch", "minor", "major"):
        return fail("level must be patch, minor or major")
    if run("git", "status", "--porcelain", capture=True):
        return fail("working tree is not clean; commit or stash first")
    if run("git", "rev-parse", "--abbrev-ref", "HEAD", capture=True) != "master":
        return fail("publish from master only")

    run(NPM, "version", level, "--no-git-tag-version")
    version = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))["version"]
    tag = f"v{version}"
    try:
        run(NPM, "test")
        run(NPM, "run", "build")
    except subprocess.CalledProcessError:
        run("git", "checkout", "--", "package.json", "package-lock.json")
        return fail("tests or build failed; version bump reverted")

    out_dir = ROOT / "release"
    out_dir.mkdir(exist_ok=True)
    archive = out_dir / f"timbre-{tag}.zip"
    with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as zf:
        for item in SHIP:
            path = ROOT / item
            files = [path] if path.is_file() else [p for p in path.rglob("*") if p.is_file()]
            for f in files:
                zf.write(f, Path("timbre") / f.relative_to(ROOT))

    run("git", "add", "package.json", "package-lock.json")
    run("git", "commit", "-m", f"release: {tag}")
    run("git", "tag", tag)
    run("git", "push", "origin", "master", tag)
    run("gh", "release", "create", tag, str(archive), "--title", f"Timbre {tag}", "--generate-notes")
    print(f"published {tag}: {archive}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
