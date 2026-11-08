package com.commanderduels;

import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.GsonBuilder;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import mage.cards.decks.Deck;
import mage.game.Game;
import mage.game.match.Match;
import mage.game.permanent.Permanent;
import mage.players.Player;
import mage.util.RandomUtil;
import mage.util.ThreadUtils;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfSystemProperty;

/**
 * The campaign's difficulty, measured (v0.9.1): a reference deck suite, played by a fair bot at a
 * fixed skill, against each ward's deck at that ward's skill, on the real engine. Not a test that
 * passes or fails on a number: it runs only with {@code -Dcampaign.measure=<games per pairing>} and
 * writes {@code target/campaign-difficulty.json}, which {@code scripts/campaign_difficulty.py}
 * summarizes. The handoff's difficulty contract is a target to measure (docs/campaign.md).
 *
 * <p>Per game: the winner (reference, warden, a draw, or the turn cap), the game's turns, the
 * reference player's own turn when it first lost life, and its own turn when the warden's
 * creatures first had power enough on the battlefield to kill it from its life then (the first
 * lethal threat; Learn Commander's T04 asks that Tibalt's come no earlier than its sixth turn).
 *
 * <p>Options: {@code -Dcampaign.reference.skill} (default 3), {@code -Dcampaign.references} (a comma
 * list of "loaner" and starter deck ids; default the loaner and two starters),
 * {@code -Dcampaign.wards} (a comma list of numbers; default all), {@code -Dcampaign.budget} (seconds a
 * game, default 300), {@code -Dcampaign.out} (the report's path). The finale plays its public
 * stand-in. Needs ./db.
 */
@EnabledIfSystemProperty(named = "campaign.measure", matches = "\\d+")
class CampaignDifficulty {
    private static final Path CONTENT = Path.of("..", "content");
    private static final String[] NAMES = {"Reference", "Warden"};

    record Contender(String id, DeckLists.CustomDeck deck) {}

    record Played(int ward, String reference, long seed, String outcome, int turns, Integer firstHit,
                  Integer firstLethal, int referenceLife, int wardenLife, long millis) {}

    @BeforeAll
    static void loadCards() {
        assertTrue(CardDatabase.load().printings() > 50_000);
        Tables.actAsClient();
    }

    @Test
    void measure() throws Exception {
        int games = Integer.parseInt(System.getProperty("campaign.measure"));
        int referenceSkill = Integer.parseInt(System.getProperty("campaign.reference.skill", "3"));
        long budget = Long.parseLong(System.getProperty("campaign.budget", "300"));
        JsonObject campaign = JsonParser.parseString(Files.readString(CONTENT.resolve("campaign.json"))).getAsJsonObject();
        int turnCap = campaign.get("turn_cap").getAsInt();
        List<Contender> references = references(campaign,
            System.getProperty("campaign.references", "loaner,starter_rg_v1,starter_wu_v1"));
        String wardsWanted = System.getProperty("campaign.wards", "");
        Path out = Path.of(System.getProperty("campaign.out", "target/campaign-difficulty.json"));
        List<Played> played = new ArrayList<>();
        for (JsonElement element : campaign.getAsJsonArray("encounters")) {
            JsonObject encounter = element.getAsJsonObject();
            int ward = encounter.get("number").getAsInt();
            if (!wardsWanted.isBlank() && !List.of(wardsWanted.split(",")).contains(String.valueOf(ward))) {
                continue;
            }
            String commander = encounter.get("commander").isJsonNull()
                ? encounter.get("fallback_commander").getAsString() : encounter.get("commander").getAsString();
            var warden = new DeckLists.CustomDeck(entries(encounter.getAsJsonArray("cards")), List.of(commander));
            int wardenSkill = encounter.get("skill").getAsInt();
            for (Contender reference : references) {
                for (int game = 0; game < games; game++) {
                    long seed = 1_000L * ward + 37L * game + reference.id().hashCode() % 1000;
                    Played result = play(ward, reference, warden, referenceSkill, wardenSkill, seed, turnCap, budget);
                    played.add(result);
                    System.out.println("CAMPAIGN " + result);
                    write(out, referenceSkill, played);
                }
            }
        }
        write(out, referenceSkill, played);
    }

    private static void write(Path out, int referenceSkill, List<Played> played) throws Exception {
        Map<String, Object> report = new LinkedHashMap<>();
        report.put("reference_skill", referenceSkill);
        report.put("games", played);
        Files.createDirectories(out.toAbsolutePath().getParent());
        Files.writeString(out, new GsonBuilder().setPrettyPrinting().create().toJson(report));
    }

    private static List<Contender> references(JsonObject campaign, String wanted) throws Exception {
        JsonObject starters = JsonParser.parseString(Files.readString(CONTENT.resolve("starter-decks.json")))
            .getAsJsonObject();
        List<Contender> found = new ArrayList<>();
        for (String id : wanted.split(",")) {
            if (id.equals("loaner")) {
                JsonObject loaner = campaign.getAsJsonObject("loaner");
                found.add(new Contender("loaner", new DeckLists.CustomDeck(entries(loaner.getAsJsonArray("cards")),
                    List.of(loaner.get("commander").getAsString()))));
                continue;
            }
            for (JsonElement element : starters.getAsJsonArray("decks")) {
                JsonObject deck = element.getAsJsonObject();
                if (deck.get("id").getAsString().equals(id)) {
                    found.add(new Contender(id, new DeckLists.CustomDeck(entries(deck.getAsJsonArray("cards")),
                        List.of(deck.get("commander").getAsString()))));
                }
            }
        }
        return found;
    }

    private static List<DeckLists.Entry> entries(JsonArray cards) {
        List<DeckLists.Entry> entries = new ArrayList<>();
        for (JsonElement element : cards) {
            JsonObject card = element.getAsJsonObject();
            // A starter deck lists its commander among its cards, by role, with a quantity.
            if (card.has("role") && card.get("role").getAsString().equals("Commander")) {
                continue;
            }
            int count = card.has("count") ? card.get("count").getAsInt()
                : card.has("quantity") ? card.get("quantity").getAsInt() : 1;
            entries.add(new DeckLists.Entry(card.get("name").getAsString(), count));
        }
        return entries;
    }

    private static Played play(int ward, Contender reference, DeckLists.CustomDeck warden, int referenceSkill,
                               int wardenSkill, long seed, int turnCap, long budgetSeconds) throws Exception {
        AtomicReference<Played> result = new AtomicReference<>();
        AtomicReference<Throwable> failure = new AtomicReference<>();
        // Measured on the game thread, read after it ends.
        int[] firstHit = {0};
        int[] firstLethal = {0};
        int[] ownTurns = {0};
        int[] lastTurn = {0};
        long started = System.nanoTime();
        Thread thread = new Thread(() -> {
            try {
                RandomUtil.setSeed(seed);
                GameFormat format = GameFormat.COMMANDER;
                List<Deck> decks = List.of(DeckLists.load(reference.deck()), DeckLists.load(warden));
                Game game = format.newGame(2, turnCap, null);
                Match match = format.newMatch("Campaign difficulty", 2);
                List<Player> players = List.of(
                    new FairBot(NAMES[0], format.range(0), referenceSkill, FairBot.seedFor(seed, 0)),
                    new FairBot(NAMES[1], format.range(1), wardenSkill, FairBot.seedFor(seed, 1)));
                for (int index : HumanGame.additionOrder(2)) {
                    LegacyDuel.seat(game, match, players.get(index), decks.get(index));
                }
                List<UUID> ids = players.stream().map(Player::getId).toList();
                format.seatTeams(game, ids);
                game.addTableEventListener(event -> {
                    if (game.getTurnNum() != lastTurn[0]) {
                        lastTurn[0] = game.getTurnNum();
                        if (ids.get(0).equals(game.getActivePlayerId())) {
                            ownTurns[0]++;
                        }
                    }
                    Player you = game.getPlayer(ids.get(0));
                    if (you == null || ownTurns[0] == 0) {
                        return;
                    }
                    if (firstHit[0] == 0 && you.getLife() < 40) {
                        firstHit[0] = ownTurns[0];
                    }
                    if (firstLethal[0] == 0) {
                        int power = 0;
                        for (Permanent permanent : game.getBattlefield().getAllActivePermanents(ids.get(1))) {
                            if (permanent.isCreature(game)) {
                                power += Math.max(0, permanent.getPower().getValue());
                            }
                        }
                        if (power >= you.getLife()) {
                            firstLethal[0] = ownTurns[0];
                        }
                    }
                });
                game.start(ids.get(RandomUtil.nextInt(2)));
                Player you = game.getPlayer(ids.get(0));
                Player them = game.getPlayer(ids.get(1));
                String outcome = !game.hasEnded() || game.getTurnNum() > turnCap ? "turn_cap"
                    : game.isADraw() ? "draw" : you.hasWon() ? "reference" : them.hasWon() ? "warden" : "none";
                result.set(new Played(ward, reference.id(), seed, outcome, game.getTurnNum(),
                    firstHit[0] == 0 ? null : firstHit[0], firstLethal[0] == 0 ? null : firstLethal[0],
                    you.getLife(), them.getLife(), 0));
            } catch (Throwable t) {
                failure.set(t);
            }
        }, ThreadUtils.THREAD_PREFIX_GAME + " campaign difficulty " + ward);
        thread.setDaemon(true);
        thread.start();
        boolean finished = BotMatchRunner.join(thread, TimeUnit.SECONDS.toMillis(budgetSeconds));
        long millis = (System.nanoTime() - started) / 1_000_000;
        if (!finished) {
            BotMatchRunner.stop(thread);
            return new Played(ward, reference.id(), seed, "timeout", lastTurn[0], firstHit[0] == 0 ? null : firstHit[0],
                firstLethal[0] == 0 ? null : firstLethal[0], 0, 0, millis);
        }
        if (failure.get() != null) {
            System.out.println("CAMPAIGN error " + BotMatchRunner.describe(failure.get()));
            return new Played(ward, reference.id(), seed, "error", lastTurn[0], null, null, 0, 0, millis);
        }
        Played done = result.get();
        return new Played(done.ward(), done.reference(), done.seed(), done.outcome(), done.turns(), done.firstHit(),
            done.firstLethal(), done.referenceLife(), done.wardenLife(), millis);
    }
}
