#!/usr/bin/env bash
# Idempotently inject Aliyun mavenCentral mirror into RN/Expo gradle included-builds.
set -euo pipefail

PATCH_MARKER="// HAPPY-PLUS-MIRROR-PATCH"

inject_kts() {
  local file="$1"
  if grep -q "$PATCH_MARKER" "$file"; then
    echo "[skip] $file (already patched)"
    return
  fi
  # Replace the pluginManagement repositories block: prepend Aliyun mirrors
  python3 - "$file" "$PATCH_MARKER" <<'PY'
import re, sys
fp, marker = sys.argv[1], sys.argv[2]
src = open(fp).read()
mirrors = f"""    {marker}
    maven {{ setUrl(\"https://maven.aliyun.com/repository/gradle-plugin\") }}
    maven {{ setUrl(\"https://maven.aliyun.com/repository/google\") }}
    maven {{ setUrl(\"https://maven.aliyun.com/repository/central\") }}
    maven {{ setUrl(\"https://maven.aliyun.com/repository/public\") }}
"""
def repl(m):
    return m.group(1) + mirrors + m.group(2)
new = re.sub(
    r"(pluginManagement\s*\{\s*\n\s*repositories\s*\{\s*\n)(\s*mavenCentral\(\))",
    repl, src, count=1
)
if new == src:
    print(f"[warn] pattern not matched in {fp}", file=sys.stderr); sys.exit(1)
open(fp, "w").write(new)
print(f"[patched] {fp}")
PY
}

# Also inject a dependencyResolutionManagement block right before include(...) if not present
inject_drm() {
  local file="$1"
  local marker="// HAPPY-PLUS-DRM-PATCH"
  if grep -q "$marker" "$file"; then
    echo "[skip drm] $file"
    return
  fi
  python3 - "$file" "$marker" <<'PY'
import re, sys
fp, marker = sys.argv[1], sys.argv[2]
src = open(fp).read()
block = f"""
{marker}
dependencyResolutionManagement {{
  repositories {{
    maven {{ setUrl(\"https://maven.aliyun.com/repository/google\") }}
    maven {{ setUrl(\"https://maven.aliyun.com/repository/central\") }}
    maven {{ setUrl(\"https://maven.aliyun.com/repository/public\") }}
    mavenCentral()
    google()
  }}
}}

"""
new = re.sub(r"(\ninclude\()", block + r"\1", src, count=1)
if new == src:
    print(f"[warn] include() not matched in {fp}", file=sys.stderr); sys.exit(1)
open(fp, "w").write(new)
print(f"[patched drm] {fp}")
PY
}

for f in \
  /opt/happy/node_modules/@react-native/gradle-plugin/settings.gradle.kts \
  /opt/happy/node_modules/expo-modules-autolinking/android/expo-gradle-plugin/settings.gradle.kts
do
  [ -f "$f" ] || { echo "[missing] $f"; continue; }
  inject_kts "$f"
  inject_drm "$f"
done

echo "===patched files==="
grep -l "HAPPY-PLUS-MIRROR-PATCH" \
  /opt/happy/node_modules/@react-native/gradle-plugin/settings.gradle.kts \
  /opt/happy/node_modules/expo-modules-autolinking/android/expo-gradle-plugin/settings.gradle.kts
