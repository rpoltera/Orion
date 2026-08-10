#!/bin/bash
LOG=/var/log/orion_hls_scan.log
exec >>"$LOG" 2>&1
echo "===== $(date) ====="
/usr/bin/python3 /opt/orion/clean_partial_hls.py
echo "===== done ====="
