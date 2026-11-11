#!/usr/bin/env bash
# Capture entry point.
#
# There is no desktop recording any more: recording a screen region picked up
# whatever else was open. scripts/shoot.mjs renders Chrome offscreen, so the only
# thing that can appear in a frame is the page.
#
#   ./scripts/film.sh check                  dry run, spends nothing
#   ./scripts/film.sh take --yes-spend       the real take (forty completions)
#   ./scripts/film.sh frames film/x.mp4 dir  one frame every two seconds
#
# Then ./scripts/edit.sh turns the segments into the upload file.
exec node "$(dirname "$0")/shoot.mjs" "$@"
