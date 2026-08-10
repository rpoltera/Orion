#!/usr/bin/env python3
"""Delete source files for preseg errors. DRY RUN by default."""
import json, os, sys, shutil, time
from pathlib import Path

PRESEG_DB = '/var/lib/orion/sf/preseg.json'
LOG_FILE = '/var/log/orion_partial_cleanup.log'

def log(msg):
    line = f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {msg}"
    print(line)
    try:
        with open(LOG_FILE, 'a') as f: f.write(line + '\n')
    except: pass

def get_hls_dir(file_path):
    p = Path(file_path)
    return p.parent / '.hls' / p.stem

def main():
    dry_run = '--execute' not in sys.argv
    if not os.path.exists(PRESEG_DB):
        log(f"ERROR: {PRESEG_DB} not found"); sys.exit(1)
    with open(PRESEG_DB) as f:
        db = json.load(f)
    errors = [{'media_id': k, 'file_path': v.get('filePath',''), 'error': v.get('error','?'), 'name': v.get('displayName',k)}
              for k, v in db.items() if v.get('status') == 'error']
    if not errors:
        log("No error entries found."); return
    log(f"Found {len(errors)} error entries")
    log("=" * 80)
    log("MODE: " + ("DRY RUN" if dry_run else "EXECUTE - WILL DELETE"))
    log("=" * 80)
    valid, missing = [], []
    for e in errors:
        fp = e['file_path']
        if not fp: log(f"SKIP: {e['name']} - no path"); continue
        if not os.path.exists(fp): missing.append(e); log(f"MISSING: {fp}"); continue
        valid.append(e)
    log("=" * 80)
    log(f"Files to delete: {len(valid)} | DB-only entries: {len(missing)}")
    log("=" * 80)
    total_size = 0
    for e in valid:
        fp = e['file_path']
        try: size = os.path.getsize(fp); total_size += size
        except: size = 0
        hls = get_hls_dir(fp)
        marker = " (+ .hls dir)" if hls.exists() else ""
        log(f"  [{size/(1024*1024):.0f} MB] {fp}{marker}")
    log("=" * 80)
    log(f"Total to free: {total_size/(1024*1024*1024):.2f} GB")
    log("=" * 80)
    if dry_run:
        log("DRY RUN COMPLETE. Run with --execute to actually delete.")
        return
    backup = f"{PRESEG_DB}.bak.{int(time.time())}"
    shutil.copy2(PRESEG_DB, backup); log(f"Backup: {backup}")
    deleted, failed = 0, 0
    for e in valid:
        fp = e['file_path']
        try:
            os.remove(fp); deleted += 1; log(f"DELETED: {fp}")
            hls = get_hls_dir(fp)
            if hls.exists(): shutil.rmtree(hls); log(f"DELETED HLS: {hls}")
        except Exception as ex:
            failed += 1; log(f"FAILED {fp}: {ex}")
    all_ids = set(e['media_id'] for e in valid + missing)
    for mid in all_ids:
        if mid in db: del db[mid]
    with open(PRESEG_DB, 'w') as f: json.dump(db, f)
    log(f"Removed {len(all_ids)} entries from preseg.json")
    log(f"Deleted {deleted} files, {failed} failed. Backup: {backup}")
    log("Restart orion: systemctl restart orion")

if __name__ == '__main__':
    main()
