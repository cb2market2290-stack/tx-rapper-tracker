#!/bin/bash
# Restore bitrue-analyzer app.js from the known-good backup
# Run this if app.js ever gets corrupted or overwritten

APP_DIR="/Users/cb2market/clawd/projects/bitrue-analyzer"
BACKUP="$APP_DIR/app_backup.js"
TARGET="$APP_DIR/app.js"

if [ ! -f "$BACKUP" ]; then
    echo "ERROR: Backup not found at $BACKUP"
    exit 1
fi

node --check "$BACKUP" 2>&1
if [ $? -ne 0 ]; then
    echo "WARNING: Backup has a syntax error Ñ aborting restore"
    exit 1
fi

cp "$BACKUP" "$TARGET"
echo "Restored app.js from backup ($(date))"
node --check "$TARGET" 2>&1 && echo "Syntax OK Ñ restore complete"
