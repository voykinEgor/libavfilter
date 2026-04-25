#!/bin/sh
set -eu

FFMPEG_DIR="${1:-/tmp/ffmpeg}"
CONFIGURE_FILE="$FFMPEG_DIR/configure"
MAKEFILE_FILE="$FFMPEG_DIR/libavfilter/Makefile"
ALLFILTERS_FILE="$FFMPEG_DIR/libavfilter/allfilters.c"

if [ ! -f "$CONFIGURE_FILE" ] || [ ! -f "$MAKEFILE_FILE" ] || [ ! -f "$ALLFILTERS_FILE" ]; then
  echo "ffmpeg tree not found: $FFMPEG_DIR" >&2
  exit 1
fi

# 1) Register libfvad as an external library option.
if ! grep -q '^[[:space:]]*libfvad$' "$CONFIGURE_FILE"; then
  sed -i '/^[[:space:]]*libfontconfig$/a\    libfvad' "$CONFIGURE_FILE"
fi

# 2) Add smartvad filter deps in configure.
if ! grep -q '^smartvad_filter_deps="libfvad"$' "$CONFIGURE_FILE"; then
  sed -i '/^aresample_filter_deps="swresample"$/a\smartvad_filter_deps="libfvad"' "$CONFIGURE_FILE"
fi

# 3) Add pkg-config check for libfvad.
if ! grep -q '^enabled libfvad[[:space:]]*&& require_pkg_config libfvad libfvad fvad.h fvad_new$' "$CONFIGURE_FILE"; then
  sed -i '/^enabled libflite[[:space:]]*&& require libflite /i\enabled libfvad           \&\& require_pkg_config libfvad libfvad fvad.h fvad_new' "$CONFIGURE_FILE"
fi

# 4) Build af_smartvad.o with libavfilter.
if ! grep -q '^OBJS-\$(CONFIG_SMARTVAD_FILTER)[[:space:]]*+= af_smartvad.o$' "$MAKEFILE_FILE"; then
  sed -i '/^OBJS-\$(CONFIG_SILENCEREMOVE_FILTER)[[:space:]]*+= af_silenceremove.o$/a\OBJS-$(CONFIG_SMARTVAD_FILTER)               += af_smartvad.o' "$MAKEFILE_FILE"
fi

# 5) Expose filter symbol so configure generates it into filter_list.c.
if ! grep -q '^extern const FFFilter ff_af_smartvad;$' "$ALLFILTERS_FILE"; then
  tmp_file="$(mktemp)"
  awk '
    {
      print
      if ($0 == "#include \"filters.h\"") {
        print ""
        print "extern const FFFilter ff_af_smartvad;"
      }
    }
  ' "$ALLFILTERS_FILE" > "$tmp_file"
  mv "$tmp_file" "$ALLFILTERS_FILE"
fi

echo "smartvad patch applied successfully"
