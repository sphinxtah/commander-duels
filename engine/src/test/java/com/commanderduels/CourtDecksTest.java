package com.commanderduels;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

/**
 * The court's decks (v0.9.6): ward 15 as the API serves it, from {@code content/campaign.json}. The
 * Sphinx's deck (with its public stand-in commander) and the two he gifted Nicol Bolas and Liliana are
 * team B, bots at skill 6, against a scripted human King A and two bot Generals on fixture decks. Every
 * card of the three decks must be one the engine knows, and the game must play to its end or its turn
 * cap. (SeatChecks' leak checks know the fixture decks only.) The game is played only with
 * {@code -Dcampaign.court=true} (about two minutes); the decks' cards are checked always. Needs ./db.
 */
class CourtDecksTest {
    private static JsonObject court;

    @BeforeAll
    static void load() throws Exception {
        assertTrue(CardDatabase.load().printings() > 50_000);
        Tables.actAsClient();
        JsonObject content = JsonParser.parseString(
            Files.readString(Path.of("../content/campaign.json"), StandardCharsets.UTF_8)).getAsJsonObject();
        JsonArray encounters = content.getAsJsonArray("encounters");
        JsonObject sphinx = null;
        JsonObject found = null;
        for (JsonElement element : encounters) {
            JsonObject encounter = element.getAsJsonObject();
            if (encounter.get("number").getAsInt() == 14) {
                sphinx = encounter;
            }
            if (encounter.has("court")) {
                found = encounter;
            }
        }
        assertTrue(sphinx != null && found != null, "ward 14 and the court");
        found.add("cards", sphinx.getAsJsonArray("cards"));
        court = found;
    }

    private static DeckLists.CustomDeck deck(JsonArray cards, String commander) throws Exception {
        JsonObject list = new JsonObject();
        list.add("cards", cards);
        JsonArray commanders = new JsonArray();
        commanders.add(commander);
        list.add("commanders", commanders);
        return DeckLists.parse(list, GameFormat.KINGS_TABLE_COMMANDER);
    }

    @Test
    void theCourtsDecksNameOnlyCardsTheEngineKnows() throws Exception {
        for (JsonElement element : court.getAsJsonObject("court").getAsJsonArray("generals")) {
            JsonObject general = element.getAsJsonObject();
            DeckLists.CustomDeck parsed = deck(general.getAsJsonArray("cards"), general.get("commander").getAsString());
            assertTrue(DeckLists.unknown(parsed).isEmpty(), general.get("name") + ": " + DeckLists.unknown(parsed));
            assertEquals(99, parsed.cards().stream().mapToInt(DeckLists.Entry::count).sum());
        }
    }

    @Test
    void theCourtPlaysItsDecks() throws Exception {
        assumeTrue(Boolean.getBoolean("campaign.court"), "the court's game: -Dcampaign.court=true");
        List<DeckLists.CustomDeck> teamB = new ArrayList<>();
        JsonArray generals = court.getAsJsonObject("court").getAsJsonArray("generals");
        DeckLists.CustomDeck bolas = null;
        DeckLists.CustomDeck liliana = null;
        for (JsonElement element : generals) {
            JsonObject general = element.getAsJsonObject();
            DeckLists.CustomDeck parsed = deck(general.getAsJsonArray("cards"), general.get("commander").getAsString());
            assertTrue(DeckLists.unknown(parsed).isEmpty(), general.get("name") + ": " + DeckLists.unknown(parsed));
            if (general.get("seat").getAsInt() == 3) {
                bolas = parsed;
            } else {
                liliana = parsed;
            }
        }
        DeckLists.CustomDeck sphinx = deck(court.getAsJsonArray("cards"), court.get("fallback_commander").getAsString());
        assertTrue(DeckLists.unknown(sphinx).isEmpty(), "The Sphinx: " + DeckLists.unknown(sphinx));
        teamB.add(bolas);
        teamB.add(sphinx);
        teamB.add(liliana);

        var rules = new KingsTableRules(true, KingsTableRules.ALL_40, false);
        List<String> fixtures = GameFormat.KINGS_TABLE_COMMANDER.decks();
        List<HumanGameRequest.Seat> seats = new ArrayList<>();
        seats.add(Tables.bot(fixtures.get(0)));
        seats.add(Tables.human(fixtures.get(1)));
        seats.add(Tables.bot(fixtures.get(2)));
        for (DeckLists.CustomDeck custom : teamB) {
            seats.add(new HumanGameRequest.Seat(HumanGameRequest.BOT, HumanGameRequest.CUSTOM_DECK, custom));
        }
        var request = new HumanGameRequest(15015L, GameFormat.KINGS_TABLE_COMMANDER, seats, 6,
            Integer.getInteger("court.turns", 8), 900, 0, null, null, rules);
        var scripted = new ScriptedPlayer(15015L);
        var coverage = new Tables.Coverage();
        HumanGame game = Tables.start(request, HumanGame.Hooks.NONE);
        Tables.Played played = Tables.play(game, (seat, prompt, view) -> scripted.choose(prompt, view),
            Long.getLong("court.minutes", 20), coverage);
        HumanGame.Result result = played.last().result();
        System.out.println("The court: " + result);
        assertTrue(Set.of("completed", "turn_limit").contains(result.kind()), "the court finished: " + result);
        assertEquals("kings_table", played.last().settings().format());
    }
}
