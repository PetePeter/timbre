"""Dev workflow: install deps when needed, build, run Timbre on http://localhost:7790."""
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
NPM = "npm.cmd" if os.name == "nt" else "npm"


def npm(*args: str) -> None:
    subprocess.run([NPM, *args], cwd=ROOT, check=True)


def main() -> int:
    lock = ROOT / "package-lock.json"
    stamp = ROOT / "node_modules" / ".package-lock.json"
    if not stamp.exists() or stamp.stat().st_mtime < lock.stat().st_mtime:
        npm("ci")
    try:
        npm("start")
    except KeyboardInterrupt:
        pass
    except subprocess.CalledProcessError as err:
        return err.returncode
    return 0


if __name__ == "__main__":
    sys.exit(main())
