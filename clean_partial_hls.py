#!/usr/bin/env python3
"""Auto-runs nightly. Deletes incomplete .hls folders. No prompts."""
import os, re, subprocess, shutil, time
from concurrent.futures import ThreadPoolExecutor, as_completed

ROOTS = ['/mnt/jbod1/media/tv_shows', '/mnt/jbod1/movies', '/mnt/jbod1/Movies']
SLACK = 30
MAX_WORKERS = 8  # lower at night to not disrupt streams

def probe_duration(fp):
    try:
        r = subprocess.run(
            ['ffprobe','-v','error','-show_entries','format=duration',
             '-of','default=noprint_wrappers=1:nokey=1', fp],
            capture_output=True, timeout=10, text=True)
        return float(r.stdout.strip()) if r.stdout.strip() else None
    except Exception:
        return None

def m3u8_total_duration(p):
    total = 0.0
    try:
        with open(p) as f:
            for line in f:
                m = re.match(r'#EXTINF:([\d.]+)', line)
                if m: total += float(m.group(1))
    except Exception:
        return None
    return total

def find_hls():
    for root in ROOTS:
        if not os.path.isdir(root): continue
        for dirpath, _, _ in os.walk(root):
            if os.path.basename(dirpath) != '.hls': continue
            parent = os.path.dirname(dirpath)
            try:
                entries = os.listdir(dirpath)
            except Exception:
                continue
            for entry in entries:
                full = os.path.join(dirpath, entry)
                if not os.path.isdir(full): continue
                src = None
                for ext in ('.mp4','.mkv','.avi','.m4v','.ts','.webm'):
                    c = os.path.join(parent, entry+ext)
                    if os.path.exists(c):
                        src = c; break
                yield (full, src)

def check(pair):
    hls_dir, src = pair
    m3u8 = os.path.join(hls_dir, 'index.m3u8')
    if not os.path.exists(m3u8): return (hls_dir, 'no_m3u8', 0, 0)
    hls_dur = m3u8_total_duration(m3u8) or 0
    if src is None: return (hls_dir, 'no_source', hls_dur, 0)
    src_dur = probe_duration(src) or 0
    if src_dur <= 0: return (hls_dir, 'probe_failed', hls_dur, src_dur)
    if hls_dur < src_dur - SLACK: return (hls_dir, 'incomplete', hls_dur, src_dur)
    return (hls_dir, 'ok', hls_dur, src_dur)

print(f'[{time.strftime("%F %T")}] Nightly .hls integrity scan starting', flush=True)
all_dirs = list(find_hls())
print(f'[{time.strftime("%F %T")}] Found {len(all_dirs)} .hls folders', flush=True)

bad = []
with ThreadPoolExecutor(max_workers=MAX_WORKERS) as ex:
    futs = [ex.submit(check, p) for p in all_dirs]
    for f in as_completed(futs):
        r = f.result()
        if r[1] == 'incomplete' or r[1] == 'no_m3u8':
            bad.append(r)

print(f'[{time.strftime("%F %T")}] Incomplete/broken: {len(bad)}')
for hls_dir, status, hls_dur, src_dur in bad:
    short = hls_dir.replace('/mnt/jbod1/media/tv_shows/','').replace('/mnt/jbod1/','')
    print(f'  [{status}] {short} hls={hls_dur:.0f}s src={src_dur:.0f}s')

deleted = 0
for hls_dir, _, _, _ in bad:
    try:
        shutil.rmtree(hls_dir)
        deleted += 1
    except Exception as e:
        print(f'  FAIL delete {hls_dir}: {e}')

print(f'[{time.strftime("%F %T")}] Deleted {deleted}/{len(bad)} bad .hls folders')

# Trigger orion re-queue of deleted items (soft: hit the API endpoint)
# We don't restart orion — just clear the preseg DB entries for deleted files
# so queue-all picks them up again.
try:
    import json
    db_path = '/var/lib/orion/sf/preseg.json'
    db = json.load(open(db_path))
    removed = 0
    for hls_dir, _, _, _ in bad:
        # hls_dir like /mnt/.../.hls/<basename>
        base = os.path.basename(hls_dir)
        for mid, info in list(db.items()):
            fp = info.get('filePath','')
            if fp and os.path.basename(os.path.splitext(fp)[0]) == base:
                db.pop(mid, None)
                removed += 1
                break
    json.dump(db, open(db_path, 'w'))
    print(f'[{time.strftime("%F %T")}] Removed {removed} entries from preseg.json (will re-queue)')
except Exception as e:
    print(f'[{time.strftime("%F %T")}] preseg.json cleanup failed: {e}')

print(f'[{time.strftime("%F %T")}] Scan done')
