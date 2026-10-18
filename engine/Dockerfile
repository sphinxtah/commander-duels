FROM eclipse-temurin:21.0.7_6-jdk AS build
WORKDIR /build
COPY engine/src ./src
RUN mkdir out && javac -Xlint:all -Werror -d out src/main/java/com/commanderduels/*.java src/test/java/com/commanderduels/*.java && java -cp out com.commanderduels.EngineServerTest
FROM eclipse-temurin:21.0.7_6-jre
WORKDIR /app
COPY --from=build /build/out ./out
USER 10001:10001
EXPOSE 8090
CMD ["java", "-cp", "out", "com.commanderduels.EngineServer"]
