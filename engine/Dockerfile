# Stage "xmage" depends only on engine/xmage/{pin.properties,build-xmage.sh,patches}, so XMage is
# recompiled only when the pin, the build script or a patch changes. Locally BuildKit reuses the
# layer; CI restores it from the GitHub Actions cache.
FROM maven:3.9.16-eclipse-temurin-21 AS xmage
ENV XMAGE_M2=/xmage/m2
WORKDIR /xmage
COPY engine/xmage/pin.properties engine/xmage/build-xmage.sh ./
COPY engine/xmage/patches ./patches
RUN sh build-xmage.sh

# Card database: XMage's classpath scan into H2, run once per pin at image-build time.
FROM xmage AS carddb
WORKDIR /xmage/carddb
COPY engine/xmage/BuildCardDatabase.java /xmage/
RUN java -Xmx2g -cp "$(cat /xmage/mage-sets.classpath)" /xmage/BuildCardDatabase.java \
    && echo "card database cgroup memory.peak $(cat /sys/fs/cgroup/memory.peak) bytes" \
    && rm -f db/*.trace.db && ls -l db

# Engine module, compiled and tested (JUnit, including real bot games) against the pinned XMage.
# XMage artifacts come read-only from /xmage/m2; other downloads use a BuildKit cache mount.
FROM carddb AS engine-build
WORKDIR /build/engine
ARG ENGINE_SKIP_TESTS=false
COPY engine/pom.xml ./
COPY engine/xmage/pin.properties ./xmage/
COPY engine/decks ./decks
COPY engine/src ./src
RUN ln -s /xmage/carddb/db db
RUN --mount=type=cache,target=/root/.m2/repository \
    mvn -B -ntp -Dmaven.repo.local.tail=/xmage/m2 -DskipTests=${ENGINE_SKIP_TESTS} verify \
    && mvn -B -ntp -q -Dmaven.repo.local.tail=/xmage/m2 license:add-third-party

FROM eclipse-temurin:21.0.12_8-jre AS runtime
WORKDIR /app
COPY --from=xmage /xmage/licenses ./licenses
COPY --from=carddb --chown=10001:10001 /xmage/carddb/db ./db
COPY --from=engine-build /build/engine/target/lib ./lib
COPY --from=engine-build /build/engine/target/licenses/THIRD-PARTY.txt ./licenses/
COPY engine/decks ./decks
COPY --from=engine-build /build/engine/target/engine.jar ./engine.jar
USER 10001:10001
# h2.bindAddress keeps the TCP listener that XMage's H2 AUTO_SERVER setting starts on loopback.
ENV CD_ENGINE_DECKS=/app/decks \
    JDK_JAVA_OPTIONS="-Xms256m -Xmx768m -XX:+UseG1GC -XX:+ExitOnOutOfMemoryError -Dh2.bindAddress=127.0.0.1"
EXPOSE 8090
CMD ["java", "-cp", "/app/engine.jar:/app/lib/*", "com.commanderduels.EngineServer"]
