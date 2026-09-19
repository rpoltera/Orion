#!/usr/bin/env python3
"""Export/import Orion StreamForge channels between two Orion installations.

The import replaces the destination's StreamForge channels, but leaves Orion
libraries, users, settings, IPTV channels, media data and artwork untouched.
It carries over live StreamForge sources required by transferred channels and
maps production media IDs to the destination's media IDs by file path first,
then by episode/title metadata.  Media IDs differ after independent scans.
"""

import argparse
import copy
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import time
import unicodedata
import uuid
from datetime import datetime, timezone
from pathlib import Path

FORMAT = "orion-streamforge-channels-v1"
MEDIA_KEYS = ("movies", "tvShows", "music", "musicVideos")


def fail(message):
    print(f"ERROR: {message}", file=sys.stderr)
    raise SystemExit(1)


def load_json(path, default=None):
    try:
        with Path(path).open("r", encoding="utf-8") as handle:
            return json.load(handle)
    except FileNotFoundError:
        return copy.deepcopy(default)
    except json.JSONDecodeError as exc:
        fail(f"{path} is not valid JSON: {exc}")


def write_json_atomic(path, data):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(data, handle, indent=2, ensure_ascii=False)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp_name, path)
    finally:
        if os.path.exists(temp_name):
            os.unlink(temp_name)


def normalized(value):
    value = unicodedata.normalize("NFKD", str(value or ""))
    return "".join(c for c in value if not unicodedata.combining(c)).lower()


def path_key(value):
    if not value:
        return ""
    return os.path.normcase(os.path.normpath(str(value)))


def service_data_dir():
    configured = os.environ.get("ORION_DATA_DIR", "")
    defaults = Path("/etc/default/orion")
    if defaults.exists():
        for line in defaults.read_text(encoding="utf-8", errors="replace").splitlines():
            if line.startswith("ORION_DATA_DIR="):
                configured = line.split("=", 1)[1].strip().strip('"').strip("'")
    return Path(configured or "/var/lib/orion")


def streamforge_paths():
    data_dir = service_data_dir()
    config = load_json(data_dir / "config.json", {}) or {}
    sf_dir = Path(str(config.get("sfDataDir") or data_dir / "sf"))
    return data_dir, sf_dir, sf_dir / "channels.json", sf_dir / "streams.json"


def library_items(data_dir):
    db_path = data_dir / "orion.db"
    if not db_path.exists():
        fail(f"Orion database not found: {db_path}")
    try:
        conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
        rows = conn.execute(
            "SELECT key, value FROM kv_arrays WHERE key IN (?, ?, ?, ?)", MEDIA_KEYS
        ).fetchall()
        conn.close()
    except sqlite3.Error as exc:
        fail(f"Cannot read {db_path}: {exc}")

    output = []
    for _, value in rows:
        try:
            entries = json.loads(value)
        except json.JSONDecodeError:
            continue
        if isinstance(entries, list):
            output.extend(entry for entry in entries if isinstance(entry, dict))
    return output


def item_ref(item):
    return {
        "filePath": item.get("filePath") or item.get("path") or item.get("localPath") or "",
        "title": item.get("title") or item.get("episodeTitle") or item.get("fileName") or "",
        "seriesTitle": item.get("seriesTitle") or item.get("showName") or "",
        "season": item.get("season") if item.get("season") is not None else item.get("seasonNum"),
        "episode": item.get("episode") if item.get("episode") is not None else item.get("episodeNum"),
        "year": item.get("year"),
    }


def media_indexes(items):
    by_id = {}
    by_path = {}
    by_episode = {}
    by_title_year = {}

    for item in items:
        item_id = item.get("id")
        if not item_id:
            continue
        ref = item_ref(item)
        by_id[str(item_id)] = ref

        key = path_key(ref["filePath"])
        if key:
            by_path.setdefault(key, str(item_id))

        show = normalized(ref["seriesTitle"] or item.get("title"))
        season, episode = ref["season"], ref["episode"]
        if show and season is not None and episode is not None:
            by_episode.setdefault((show, str(season), str(episode)), str(item_id))

        title = normalized(ref["title"])
        if title:
            by_title_year.setdefault((title, str(ref["year"] or "")), str(item_id))
    return by_id, by_path, by_episode, by_title_year


def referenced_media_ids(channels):
    ids = set()
    for channel in channels:
        for block in channel.get("playout") or []:
            if isinstance(block, dict) and block.get("mediaId"):
                ids.add(str(block["mediaId"]))
        schedule = channel.get("seriesSchedule") or {}
        for episode in schedule.get("episodes") or []:
            if not isinstance(episode, dict):
                continue
            media_id = episode.get("mediaId") or episode.get("id")
            if media_id:
                ids.add(str(media_id))
    return ids


def export_channels(destination):
    data_dir, sf_dir, channels_file, streams_file = streamforge_paths()
    channels = load_json(channels_file, [])
    streams = load_json(streams_file, [])
    if not isinstance(channels, list):
        fail(f"Expected a channel array in {channels_file}")
    if not isinstance(streams, list):
        streams = []

    # EPG programs are derived from the library and must be rebuilt on the lab.
    clean_channels = copy.deepcopy(channels)
    for channel in clean_channels:
        channel.pop("scheduledPrograms", None)
        channel.pop("scheduledProgramsGeneratedAt", None)

    source_by_id, _, _, _ = media_indexes(library_items(data_dir))
    refs = {
        media_id: source_by_id[media_id]
        for media_id in referenced_media_ids(clean_channels)
        if media_id in source_by_id
    }
    live_ids = {str(ch.get("liveStreamId")) for ch in clean_channels if ch.get("liveStreamId")}
    linked_streams = [copy.deepcopy(s) for s in streams if str(s.get("id")) in live_ids]

    payload = {
        "format": FORMAT,
        "exportedAt": datetime.now(timezone.utc).isoformat(),
        "source": {"dataDir": str(data_dir), "streamForgeDir": str(sf_dir)},
        "channels": clean_channels,
        "mediaRefs": refs,
        "linkedStreams": linked_streams,
    }
    write_json_atomic(destination, payload)
    print(f"Exported {len(clean_channels)} StreamForge channels to {destination}")
    print(f"Included {len(refs)} portable media references and {len(linked_streams)} linked live streams")


def resolve_media(ref, by_path, by_episode, by_title_year):
    if not isinstance(ref, dict):
        return None
    candidate = by_path.get(path_key(ref.get("filePath")))
    if candidate:
        return candidate

    show = normalized(ref.get("seriesTitle") or "")
    season, episode = ref.get("season"), ref.get("episode")
    if show and season is not None and episode is not None:
        candidate = by_episode.get((show, str(season), str(episode)))
        if candidate:
            return candidate

    title = normalized(ref.get("title"))
    if title:
        return by_title_year.get((title, str(ref.get("year") or ""))) or by_title_year.get((title, ""))
    return None


def import_channels(source_file):
    if os.geteuid() != 0:
        fail("Run import as root inside the destination Orion LXC.")
    payload = load_json(source_file)
    if not isinstance(payload, dict) or payload.get("format") != FORMAT:
        fail("This is not an Orion StreamForge channel export file.")
    channels = payload.get("channels")
    if not isinstance(channels, list):
        fail("Export file has no valid channel list.")

    data_dir, sf_dir, channels_file, streams_file = streamforge_paths()
    _, by_path, by_episode, by_title_year = media_indexes(library_items(data_dir))
    refs = payload.get("mediaRefs") or {}
    imported = copy.deepcopy(channels)
    remapped = 0
    unresolved = []

    for channel in imported:
        channel.pop("scheduledPrograms", None)
        channel["scheduledProgramsGeneratedAt"] = 0
        for block in channel.get("playout") or []:
            if not isinstance(block, dict) or not block.get("mediaId"):
                continue
            old_id = str(block["mediaId"])
            new_id = resolve_media(refs.get(old_id), by_path, by_episode, by_title_year)
            if new_id:
                block["mediaId"] = new_id
                remapped += 1
            else:
                unresolved.append(f"{channel.get('name', '?')}: playout {block.get('title', old_id)}")

        schedule = channel.get("seriesSchedule") or {}
        for episode in schedule.get("episodes") or []:
            if not isinstance(episode, dict):
                continue
            old_id = str(episode.get("mediaId") or episode.get("id") or "")
            if not old_id:
                continue
            new_id = resolve_media(refs.get(old_id), by_path, by_episode, by_title_year)
            if new_id:
                episode["mediaId"] = new_id
                if "id" in episode:
                    episode["id"] = new_id
                remapped += 1
            else:
                unresolved.append(f"{channel.get('name', '?')}: S{episode.get('season', '?')}E{episode.get('episode', '?')}")

    existing_streams = load_json(streams_file, [])
    if not isinstance(existing_streams, list):
        existing_streams = []
    stream_map = {}
    existing_by_url = {str(s.get("url")): s for s in existing_streams if s.get("url")}
    existing_ids = {str(s.get("id")) for s in existing_streams if s.get("id")}
    for source_stream in payload.get("linkedStreams") or []:
        old_id = str(source_stream.get("id") or "")
        if not old_id:
            continue
        match = existing_by_url.get(str(source_stream.get("url") or ""))
        if match:
            stream_map[old_id] = str(match.get("id"))
            continue
        new_stream = copy.deepcopy(source_stream)
        if not new_stream.get("id") or str(new_stream["id"]) in existing_ids:
            new_stream["id"] = str(uuid.uuid4())
        existing_ids.add(str(new_stream["id"]))
        existing_streams.append(new_stream)
        stream_map[old_id] = str(new_stream["id"])

    for channel in imported:
        old_live_id = str(channel.get("liveStreamId") or "")
        if old_live_id and old_live_id in stream_map:
            channel["liveStreamId"] = stream_map[old_live_id]

    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    backup_dir = sf_dir / "channel-import-backups" / stamp
    backup_dir.mkdir(parents=True, exist_ok=True)
    if channels_file.exists():
        shutil.copy2(channels_file, backup_dir / "channels.json")
    if streams_file.exists():
        shutil.copy2(streams_file, backup_dir / "streams.json")

    was_active = subprocess.run(["systemctl", "is-active", "--quiet", "orion"]).returncode == 0
    if was_active:
        subprocess.run(["systemctl", "stop", "orion"], check=True)
    try:
        write_json_atomic(channels_file, imported)
        write_json_atomic(streams_file, existing_streams)
        shutil.chown(channels_file, user="orion", group="orion")
        shutil.chown(streams_file, user="orion", group="orion")
        if was_active:
            subprocess.run(["systemctl", "start", "orion"], check=True)
            time.sleep(8)
            subprocess.run(["systemctl", "is-active", "--quiet", "orion"], check=True)
    except Exception:
        print(f"Import failed; restoring {backup_dir}", file=sys.stderr)
        if (backup_dir / "channels.json").exists():
            shutil.copy2(backup_dir / "channels.json", channels_file)
        if (backup_dir / "streams.json").exists():
            shutil.copy2(backup_dir / "streams.json", streams_file)
        if was_active:
            subprocess.run(["systemctl", "start", "orion"], check=False)
        raise

    print(f"Imported {len(imported)} StreamForge channels")
    print(f"Remapped {remapped} media references; {len(unresolved)} could not be matched")
    if unresolved:
        print("Unmatched (first 20):")
        for item in unresolved[:20]:
            print(f"  - {item}")
    print(f"Destination backup: {backup_dir}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    export = commands.add_parser("export", help="Create a portable StreamForge channel export")
    export.add_argument("--output", required=True, type=Path)
    imp = commands.add_parser("import", help="Replace this Orion's StreamForge channels from an export")
    imp.add_argument("--input", required=True, type=Path)
    args = parser.parse_args()

    if args.command == "export":
        export_channels(args.output)
    else:
        import_channels(args.input)


if __name__ == "__main__":
    main()
