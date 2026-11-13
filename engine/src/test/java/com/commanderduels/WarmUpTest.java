package com.commanderduels;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;

import com.google.gson.JsonObject;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.FileTime;
import java.util.List;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

/**
 * Which game a game process warms up with (v0.9.11): the newest recorded game of its size and of
 * its size's main format, read from the recordings' manifests alone.
 */
class WarmUpTest {
    private Path recordings;
    private long minute;

    @BeforeEach
    void folder() throws Exception {
        recordings = Files.createTempDirectory("recordings");
    }

    @AfterEach
    void delete() throws Exception {
        Recordings.deleteAll(recordings);
    }

    /** A recording's folder with only its manifest, each newer than the last written. */
    private void recorded(String name, String format, List<String> players, List<String> decks) throws Exception {
        StringBuilder seats = new StringBuilder();
        for (int seat = 0; seat < players.size(); seat++) {
            seats.append(seat == 0 ? "" : ",").append("{\"player\":\"").append(players.get(seat))
                .append("\",\"deck\":\"").append(decks.get(seat)).append("\"}");
        }
        String request = "{\"seed\":7,\"format\":\"" + format + "\",\"skill\":2,\"turn_cap\":40,\"seats\":["
            + seats + "]}";
        JsonObject manifest = new JsonObject();
        manifest.addProperty("format", Recording.FORMAT);
        manifest.addProperty("game_id", name);
        manifest.addProperty("created_at", "2026-11-12T00:00:00Z");
        manifest.add("binding", new JsonObject());
        manifest.addProperty("service", true);
        manifest.addProperty("seed", 7);
        manifest.add("seats", new com.google.gson.JsonArray());
        manifest.addProperty("request", request);
        Path folder = Files.createDirectories(recordings.resolve(name));
        Files.writeString(folder.resolve("manifest.json"), manifest.toString());
        Files.setLastModifiedTime(folder, FileTime.fromMillis(1_800_000_000_000L + ++minute * 60_000));
    }

    private static final List<String> TABLE = List.of("human", "bot", "bot", "bot");
    private static final List<String> COMMANDER_DECKS = List.of("commander-mono-red-raiders",
        "commander-mono-white-soldiers", "commander-mono-blue-flyers", "commander-mono-green-stompers");

    @Test
    void aTablesProcessWarmsUpWithTheNewestCommanderTableAndNoOtherFormat() throws Exception {
        recorded("older-table", "commander", TABLE, COMMANDER_DECKS);
        recorded("newest-table", "commander", TABLE, List.of("commander-mono-blue-flyers",
            "commander-mono-red-raiders", "commander-mono-white-soldiers", "commander-mono-green-stompers"));
        // Newer still: a Two-Headed Giant game (a table's size), a Legacy duel, and the newest of all,
        // a Commander duel (a duel's size, not its format).
        recorded("two-headed-giant", "two_headed_giant", List.of("human", "human", "bot", "bot"),
            GameFormat.TWO_HEADED_GIANT.decks());
        recorded("legacy-duel", "legacy", List.of("human", "bot"), LegacyDuel.DECKS.subList(0, 2));
        recorded("commander-duel", "commander", List.of("human", "bot"), COMMANDER_DECKS.subList(0, 2));

        HumanGameRequest table = EngineServer.recentRequest("table", GameFormat.COMMANDER, recordings);
        assertNotNull(table);
        assertEquals(GameFormat.COMMANDER, table.format());
        assertEquals(4, table.seats().size());
        assertEquals("commander-mono-blue-flyers", table.seats().get(0).deck(), "the newest table's decks");

        HumanGameRequest duel = EngineServer.recentRequest("duel", GameFormat.LEGACY, recordings);
        assertNotNull(duel);
        assertEquals(GameFormat.LEGACY, duel.format());

        // A court's process has no Commander recording of its size: it plays the engine's decks.
        assertNull(EngineServer.recentRequest("court", GameFormat.COMMANDER, recordings));
    }

    @Test
    void aGameOfBotsAloneOrADamagedManifestIsPassedOver() throws Exception {
        recorded("table", "commander", TABLE, COMMANDER_DECKS);
        recorded("bots-alone", "commander", List.of("bot", "bot", "bot", "bot"), COMMANDER_DECKS);
        Path damaged = Files.createDirectories(recordings.resolve("damaged"));
        Files.writeString(damaged.resolve("manifest.json"), "{\"format\":");
        Files.setLastModifiedTime(damaged, FileTime.fromMillis(1_800_000_000_000L + ++minute * 60_000));

        HumanGameRequest table = EngineServer.recentRequest("table", GameFormat.COMMANDER, recordings);
        assertNotNull(table);
        assertEquals(1, table.humanSeats());
        assertNull(EngineServer.recentRequest("table", GameFormat.COMMANDER, recordings.resolve("none")));
        assertNull(EngineServer.recentRequest("table", GameFormat.COMMANDER, null));
    }
}
