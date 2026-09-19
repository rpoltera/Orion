#!/usr/bin/env python3
"""Move music videos into Genre/Artist folders and update Orion paths.

Default mode is a dry run.  Use --apply to make changes.  The systemd service
runs with --apply after a manual dry run has been reviewed.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from urllib.error import URLError, HTTPError
from urllib.request import Request, urlopen

VIDEO_EXTENSIONS = {".mp4", ".mkv", ".avi", ".mov", ".m4v", ".wmv", ".webm"}
DEFAULT_ROOT = Path("/mnt/media/MusicVids")
DEFAULT_API = "http://127.0.0.1:3001/api"
DEFAULT_PENDING = Path("/var/lib/orion/musicvideo-organize-pending.json")


def clean_artist(value: str) -> str | None:
    """Return a safe directory name without changing the video filename."""
    value = re.sub(r"[\\/\x00]+", "-", value)
    value = re.sub(r"\s+", " ", value).strip().rstrip(". ")
    if not value or value in {".", ".."} or len(value) > 120:
        return None
    return value


def artist_from_filename(filename: str) -> str | None:
    stem = Path(filename).stem.strip()
    # The library naming convention is Artist - Title.  Support an en dash
    # too, but never guess when no clear artist/title separator exists.
    match = re.split(r"\s+(?:-|–)\s+", stem, maxsplit=1)
    if len(match) != 2 or not match[0].strip() or not match[1].strip():
        return None
    return clean_artist(match[0])


def api_request(api: str, path: str, payload: dict | None = None) -> dict:
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    request = Request(
        f"{api.rstrip('/')}/{path.lstrip('/')}",
        data=data,
        headers={"X-Orion-Internal": "1", "Content-Type": "application/json"},
        method="POST" if payload is not None else "GET",
    )
    with urlopen(request, timeout=20) as response:
        return json.loads(response.read().decode("utf-8"))


def save_pending(pending_file: Path, moves: list[dict]) -> None:
    pending_file.parent.mkdir(parents=True, exist_ok=True)
    pending_file.write_text(json.dumps({"moves": moves}, indent=2) + "\n", encoding="utf-8")


def reconcile(api: str, pending_file: Path, moves: list[dict]) -> bool:
    if not moves:
        return True
    try:
        result = api_request(api, "library/musicVideos/reconcile-paths", {"moves": moves})
        print(f"Orion paths updated: {result.get('updated', 0)}")
        if pending_file.exists():
            pending_file.unlink()
        return True
    except (HTTPError, URLError, TimeoutError, ValueError) as error:
        save_pending(pending_file, moves)
        print(f"ERROR: files moved, but Orion path sync failed: {error}", file=sys.stderr)
        print(f"Pending paths saved to: {pending_file}", file=sys.stderr)
        return False


def rescan(api: str, root: Path) -> bool:
    try:
        result = api_request(api, "library/scan", {"paths": [str(root)], "type": "musicVideos"})
        print(result.get("message", "Orion scan started."))
        return True
    except (HTTPError, URLError, TimeoutError, ValueError) as error:
        print(f"WARNING: Orion rescan could not start: {error}", file=sys.stderr)
        return False


def main() -> int:
    parser = argparse.ArgumentParser(description="Organize Music Videos into Genre/Artist folders.")
    parser.add_argument("--apply", action="store_true", help="Move files. Without this, only show the plan.")
    parser.add_argument("--root", type=Path, default=DEFAULT_ROOT)
    parser.add_argument("--api", default=DEFAULT_API)
    parser.add_argument("--pending-file", type=Path, default=DEFAULT_PENDING)
    args = parser.parse_args()

    root = args.root.resolve()
    if not root.is_dir():
        print(f"ERROR: library directory not found: {root}", file=sys.stderr)
        return 2

    # Finish a previous interrupted reconciliation before moving anything new.
    if args.pending_file.exists():
        try:
            pending = json.loads(args.pending_file.read_text(encoding="utf-8")).get("moves", [])
        except (OSError, ValueError):
            print(f"ERROR: cannot read pending state: {args.pending_file}", file=sys.stderr)
            return 2
        if not reconcile(args.api, args.pending_file, pending):
            return 3

    planned: list[tuple[Path, Path]] = []
    planned_destinations: set[Path] = set()
    skipped = 0
    duplicates = 0
    for source in sorted(root.rglob("*")):
        if not source.is_file() or source.suffix.lower() not in VIDEO_EXTENSIONS:
            continue
        try:
            relative = source.relative_to(root)
        except ValueError:
            continue
        # The first level is the genre.  A file at the root has no genre and
        # is deliberately left alone rather than assigning one incorrectly.
        if len(relative.parts) < 2:
            skipped += 1
            print(f"SKIPPED (no genre): {relative}")
            continue
        artist = artist_from_filename(source.name)
        if not artist:
            skipped += 1
            print(f"SKIPPED (not 'Artist - Title'): {relative}")
            continue
        destination = root / relative.parts[0] / artist / source.name
        if source == destination:
            continue
        # Check both the filesystem and destinations already planned in this
        # run.  Two copies can live in different old folders but have the
        # same Artist/filename destination; never overwrite either one.
        if destination.exists() or destination in planned_destinations:
            duplicates += 1
            print(f"DUPLICATE (left in place): {relative} -> {destination.relative_to(root)}")
            continue
        planned.append((source, destination))
        planned_destinations.add(destination)

    print(f"Planned moves: {len(planned)} | Skipped: {skipped} | Duplicates: {duplicates}")
    for source, destination in planned:
        print(f"MOVE: {source.relative_to(root)} -> {destination.relative_to(root)}")

    if not args.apply:
        print("Dry run only. Review the list, then run again with --apply.")
        return 0

    # Verify Orion is reachable before a single filesystem change is made.
    try:
        api_request(args.api, "library/paths/musicVideos")
    except (HTTPError, URLError, TimeoutError, ValueError) as error:
        print(f"ERROR: Orion is not reachable; nothing was moved: {error}", file=sys.stderr)
        return 3

    moved: list[dict] = []
    for source, destination in planned:
        destination.parent.mkdir(parents=True, exist_ok=True)
        source.rename(destination)
        moved.append({"from": str(source), "to": str(destination)})

    if not reconcile(args.api, args.pending_file, moved):
        return 3
    rescan(args.api, root)
    print(f"Completed: {len(moved)} files moved.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
