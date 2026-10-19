#!/bin/sh
# Fetches exactly the pinned XMage commit and installs the modules Commander Duels needs into
# the Maven repository at $XMAGE_M2. Runs inside the engine image build only; XMage source and
# build output never enter the Commander Duels repository.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
prop() { sed -n "s/^$1=//p" "$here/pin.properties"; }
repo=$(prop xmage.repository)
sha=$(prop xmage.commit)
version=$(prop xmage.version)
src=${XMAGE_SRC:-/xmage/src}
m2=${XMAGE_M2:?XMAGE_M2 must name the Maven repository to install into}

seconds() { date +%s; }
started=$(seconds)

# Shallow, partial fetch of the one commit; only the needed modules are checked out.
git init -q "$src"
cd "$src"
git remote add origin "$repo"
git sparse-checkout set Mage Mage.Common Mage.Sets repository \
    Mage.Server.Plugins/Mage.Player.AI Mage.Server.Plugins/Mage.Player.AI.MAD \
    Mage.Server.Plugins/Mage.Game.TwoPlayerDuel Mage.Server.Plugins/Mage.Game.CommanderFreeForAll \
    Mage.Server.Plugins/Mage.Deck.Constructed
git fetch -q --depth 1 --filter=blob:none origin "$sha"
git -c advice.detachedHead=false checkout -q FETCH_HEAD
actual=$(git rev-parse HEAD)
[ "$actual" = "$sha" ] || { echo "Fetched $actual, expected $sha" >&2; exit 1; }
pom_version=$(sed -n '0,/<version>/s/.*<version>\(.*\)<\/version>.*/\1/p' pom.xml)
[ "$pom_version" = "$version" ] || { echo "XMage POM is $pom_version, pin says $version" >&2; exit 1; }
fetched=$(seconds)

# Isolated upstream changes, applied in name order. None are required at the current pin.
for patch in "$here"/patches/*.patch; do
    [ -e "$patch" ] || continue
    echo "Applying $(basename "$patch")"
    git apply --verbose "$patch"
done

# The Maven repository is part of the image layer, so later stages and the CI layer cache reuse
# the compiled XMage artifacts and their dependencies.
mvn="mvn -B -ntp -Dmaven.repo.local=$m2 -Dmaven.test.skip=true -Djacoco.skip=true \
    -Djava.version=21 -Djava.release=21"
export MAVEN_OPTS="${XMAGE_MAVEN_OPTS:--Xmx3g -XX:+UseParallelGC}"

mvn -v | head -3
$mvn -N install
for module in Mage Mage.Common Mage.Sets; do
    echo "Building $module"
    module_started=$(seconds)
    $mvn -f "$module/pom.xml" install
    echo "$module built in $(( $(seconds) - module_started ))s"
done
$mvn -N -f Mage.Server.Plugins/pom.xml install
for module in Mage.Player.AI Mage.Player.AI.MAD Mage.Game.TwoPlayerDuel Mage.Game.CommanderFreeForAll \
    Mage.Deck.Constructed; do
    echo "Building $module"
    $mvn -f "Mage.Server.Plugins/$module/pom.xml" install
done
# Runtime classpath of the card sets, for the card-database build step.
$mvn -q -f Mage.Sets/pom.xml dependency:build-classpath -DincludeScope=runtime \
    -Dmdep.outputFile=/xmage/mage-sets.classpath
printf ':%s' "$m2/org/mage/mage-sets/$version/mage-sets-$version.jar" >> /xmage/mage-sets.classpath
built=$(seconds)

# Keep the upstream licence; drop the source tree and build output from the layer.
mkdir -p /xmage/licenses
cp LICENSE.txt /xmage/licenses/XMAGE-LICENSE.txt
printf 'XMage %s (%s)\nSource: %s\nLicence: MIT, see XMAGE-LICENSE.txt\n' "$version" "$sha" "$repo" \
    > /xmage/licenses/XMAGE-NOTICE.txt
cd /
rm -rf "$src"

peak=$(cat /sys/fs/cgroup/memory.peak 2>/dev/null || echo unavailable)
echo "XMage build: fetch $(( fetched - started ))s, compile $(( built - fetched ))s," \
    "total $(( $(seconds) - started ))s, cgroup memory.peak $peak bytes"
