#!/bin/sh
set -eu

workspace="${JDTLS_WORKSPACE:-/analysis-cache/jdtls}"
heap="${BOBO_LSP_JAVA_XMX:-384m}"
mkdir -p "$workspace"

if [ -n "${BOBO_MAVEN_SOURCE_REPO:-}" ]; then
  maven_dir="${BOBO_LSP_CACHE_DIR:-/analysis-cache}/maven"
  settings="$maven_dir/settings.xml"
  mkdir -p "$maven_dir/repository"
  cat > "$settings.tmp" <<EOF
<settings xmlns="http://maven.apache.org/SETTINGS/1.0.0">
  <mirrors>
    <mirror>
      <id>bobocloud-analysis-cache</id>
      <mirrorOf>*</mirrorOf>
      <url>file://${BOBO_MAVEN_SOURCE_REPO}</url>
    </mirror>
  </mirrors>
</settings>
EOF
  chmod 600 "$settings.tmp"
  mv -f "$settings.tmp" "$settings"

  m2e_preferences_dir="$workspace/.metadata/.plugins/org.eclipse.core.runtime/.settings"
  m2e_preferences="$m2e_preferences_dir/org.eclipse.m2e.core.prefs"
  mkdir -p "$m2e_preferences_dir"
  m2e_preferences_tmp="$(mktemp "$m2e_preferences_dir/.org.eclipse.m2e.core.prefs.XXXXXX")"
  if [ -f "$m2e_preferences" ] && [ ! -L "$m2e_preferences" ]; then
    grep -v '^eclipse.m2.userSettingsFile=' "$m2e_preferences" > "$m2e_preferences_tmp" || true
  else
    printf '%s\n' 'eclipse.preferences.version=1' > "$m2e_preferences_tmp"
  fi
  printf 'eclipse.m2.userSettingsFile=%s\n' "$settings" >> "$m2e_preferences_tmp"
  chmod 600 "$m2e_preferences_tmp"
  mv -f "$m2e_preferences_tmp" "$m2e_preferences"
fi

launcher=""
for candidate in /opt/jdtls/plugins/org.eclipse.equinox.launcher_*.jar; do
  if [ -f "$candidate" ]; then
    launcher="$candidate"
    break
  fi
done
if [ -z "$launcher" ]; then
  echo "JDT LS launcher was not found" >&2
  exit 127
fi

exec "$JAVA_HOME/bin/java" \
  -Declipse.application=org.eclipse.jdt.ls.core.id1 \
  -Dosgi.bundles.defaultStartLevel=4 \
  -Declipse.product=org.eclipse.jdt.ls.core.product \
  -Dlog.protocol=false \
  -Dlog.level=WARNING \
  -Xms64m \
  "-Xmx$heap" \
  --add-modules=ALL-SYSTEM \
  --add-opens java.base/java.util=ALL-UNNAMED \
  --add-opens java.base/java.lang=ALL-UNNAMED \
  -jar "$launcher" \
  -configuration /opt/jdtls/config_linux \
  -data "$workspace"
