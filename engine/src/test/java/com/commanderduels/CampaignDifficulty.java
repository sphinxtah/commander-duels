package com.commanderduels;

import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.GsonBuilder;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.lang.management.ManagementFactory;
import java.lang.management.MemoryPoolMXBean;
import java.lang.management.MemoryType;
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
 * {@code -Dcampaign.trace} (v0.9.3: print every game's log), {@code -Dcampaign.wards} (a comma list of
 * numbers; default all), {@code -Dcampaign.budget} (seconds a
 * game, default 300), {@code -Dcampaign.out} (the report's path). The finale plays its public
 * stand-in. Needs ./db.
 *
 * <p><b>The court (v0.9.7).</b> Ward 15 is a King's Table game, so it is measured as one: the
 * reference deck is King A's, at the reference skill, with two bot Generals on the engine's fixture
 * decks at the ward's skill, as a player who brings no friend gets them; team B is the court as the
 * API serves it (The Sphinx's deck under its public stand-in commander, and the two gifted decks), at
 * the ward's skill. A game the reference King's team wins counts for the reference, one the court
 * wins for the warden. It plays without the owner's incarnation, which only the owner's engine has,
 * so the court on the live site is harder than this measures. A six-seat game at skill 6 is long
 * and heavy: give it {@code -Dcampaign.budget=1500}, few games, and a larger heap than the tests'
 * 2 GB ({@code -Dengine.test.heap=8g}), which one such game ran out of.
 */
@EnabledIfSystemProperty(named = "campaign.measure", matches = "\\d+")
class CampaignDifficulty {
    private static final Path CONTENT = Path.of("..", "content");
    private static final boolean TRACE = Boolean.getBoolean("campaign.trace");
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
        if (System.getProperty("campaign.probe") != null) {
            HeapProbe.start(Double.parseDouble(System.getProperty("campaign.probe")));
        }
        JsonObject campaign = JsonParser.parseString(Files.readString(CONTENT.resolve("campaign.json"))).getAsJsonObject();
        // The games' turn limits are the game's own (v0.9.7): 40 turns for each player, so 80 in a
        // duel and 240 at the court. Until v0.9.7 the content named one for all, 60.
        int duelTurns = HumanGameRequest.defaultTurnCap(GameFormat.COMMANDER, 2);
        int courtTurns = HumanGameRequest.defaultTurnCap(GameFormat.KINGS_TABLE_COMMANDER, KingsTableRules.SEATS);
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
            // Since v0.9.6 an encounter may play another's 99 (cards_from): The Sphinx keeps his deck.
            JsonArray cards = encounter.has("cards_from")
                ? cardsOf(campaign, encounter.get("cards_from").getAsInt()) : encounter.getAsJsonArray("cards");
            var warden = new DeckLists.CustomDeck(entries(cards), List.of(commander));
            int wardenSkill = encounter.get("skill").getAsInt();
            // The court (v0.9.7): its two Generals' decks by seat, and its King's Table settings as
            // the content names them; null for a duel.
            Map<Integer, DeckLists.CustomDeck> generals = null;
            KingsTableRules courtRules = null;
            if (encounter.has("court")) {
                courtRules = KingsTableRules.parse(encounter.getAsJsonObject("court").get("kings_table"));
                System.out.println("CAMPAIGN court " + courtRules + ", " + courtTurns + " turns");
                generals = new LinkedHashMap<>();
                for (JsonElement element2 : encounter.getAsJsonObject("court").getAsJsonArray("generals")) {
                    JsonObject general = element2.getAsJsonObject();
                    generals.put(general.get("seat").getAsInt(), new DeckLists.CustomDeck(
                        entries(general.getAsJsonArray("cards")), List.of(general.get("commander").getAsString())));
                }
            }
            for (Contender reference : references) {
                for (int game = 0; game < games; game++) {
                    long seed = 1_000L * ward + 37L * game + reference.id().hashCode() % 1000;
                    resetHeapPeaks();
                    Played result = generals != null
                        ? playCourt(ward, reference, warden, generals, courtRules, referenceSkill, wardenSkill, seed,
                            courtTurns, budget)
                        : play(ward, reference, warden, referenceSkill, wardenSkill, seed, duelTurns, budget);
                    // What the game needed of the heap (v0.9.7): the court's six seats ran out of 2 GB.
                    System.out.println("CAMPAIGN heap peak " + heapPeakMegabytes() + " MB of "
                        + Runtime.getRuntime().maxMemory() / (1024 * 1024) + " MB, ward " + ward);
                    played.add(result);
                    System.out.println("CAMPAIGN " + result);
                    write(out, referenceSkill, played);
                    if (result.outcome().equals("error")) {
                        settleHeap();
                    }
                }
            }
        }
        write(out, referenceSkill, played);
    }

    /**
     * After a game that failed (v0.9.7): a court game that ran out of heap (two of six did here, in
     * 4 GB) leaves its searches' threads holding what they held for a moment, and the next game,
     * started at once, failed at its first turn. The collector gets the time before the next game.
     */
    private static void settleHeap() throws InterruptedException {
        for (int pass = 0; pass < 3; pass++) {
            System.gc();
            Thread.sleep(5_000);
        }
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

    private static void resetHeapPeaks() {
        for (MemoryPoolMXBean pool : ManagementFactory.getMemoryPoolMXBeans()) {
            if (pool.getType() == MemoryType.HEAP) {
                pool.resetPeakUsage();
            }
        }
    }

    /** The heap's pools' peaks since the last reset, summed: an upper bound on the heap in use at once. */
    private static long heapPeakMegabytes() {
        long bytes = 0;
        for (MemoryPoolMXBean pool : ManagementFactory.getMemoryPoolMXBeans()) {
            if (pool.getType() == MemoryType.HEAP && pool.getPeakUsage() != null) {
                bytes += pool.getPeakUsage().getUsed();
            }
        }
        return bytes / (1024 * 1024);
    }

    private static JsonArray cardsOf(JsonObject campaign, int number) {
        for (JsonElement element : campaign.getAsJsonArray("encounters")) {
            JsonObject encounter = element.getAsJsonObject();
            if (encounter.get("number").getAsInt() == number) {
                return encounter.getAsJsonArray("cards");
            }
        }
        throw new IllegalArgumentException("No encounter " + number);
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
                    if (TRACE && event.getMessage() != null && !event.getMessage().isBlank()) {
                        // -Dcampaign.trace (v0.9.3): the game's log, to see how a game ended.
                        System.out.println("TRACE " + ward + " T" + game.getTurnNum() + " " + event.getMessage()
                            .replaceAll("<[^>]+>", ""));
                    }
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

    /** King A's and King B's seats at King's Table. */
    private static final int KING_A = 1;
    private static final int KING_B = 4;

    /**
     * One game of the court (v0.9.7): King's Table under the court's own settings (Commander decks,
     * everyone at 40 life, and since v0.9.7 the house rule with its guard: a King attacks any
     * opposing General, and the other King once one of that King's Generals is out). Seat 1 is the
     * reference, King A, at the reference skill; seats 0 and 2 its bot Generals on the fixture decks
     * a bot without a deck gets; seats 3, 4 and 5 the court. The first hit is the reference King's
     * first life lost, by its own turns; no first lethal threat is read, since a King is attacked
     * only once one of its Generals has fallen.
     */
    private static Played playCourt(int ward, Contender reference, DeckLists.CustomDeck sphinx,
                                    Map<Integer, DeckLists.CustomDeck> generals, KingsTableRules rules,
                                    int referenceSkill, int wardenSkill, long seed, int turnCap,
                                    long budgetSeconds) throws Exception {
        AtomicReference<Played> result = new AtomicReference<>();
        AtomicReference<Throwable> failure = new AtomicReference<>();
        int[] firstHit = {0};
        int[] ownTurns = {0};
        int[] lastTurn = {0};
        long started = System.nanoTime();
        Thread thread = new Thread(() -> {
            try {
                RandomUtil.setSeed(seed);
                GameFormat format = GameFormat.KINGS_TABLE_COMMANDER;
                List<String> fixtures = format.decks();
                List<Deck> decks = new ArrayList<>();
                List<Player> players = new ArrayList<>();
                int fixture = 0;
                for (int seat = 0; seat < KingsTableRules.SEATS; seat++) {
                    if (seat == KING_A) {
                        decks.add(DeckLists.load(reference.deck()));
                    } else if (seat == KING_B) {
                        decks.add(DeckLists.load(sphinx));
                    } else if (generals.containsKey(seat)) {
                        decks.add(DeckLists.load(generals.get(seat)));
                    } else {
                        decks.add(format.loadDeck(SeatChecks.DECKS, fixtures.get(fixture++ % fixtures.size())));
                    }
                    String name = seat == KING_A ? NAMES[0] : seat == KING_B ? NAMES[1] : "Seat " + (seat + 1);
                    players.add(new FairBot(name, format.range(seat), seat == KING_A ? referenceSkill : wardenSkill,
                        FairBot.seedFor(seed, seat)));
                }
                Game game = format.newGame(KingsTableRules.SEATS, turnCap, rules);
                Match match = format.newMatch("Campaign difficulty", KingsTableRules.SEATS);
                for (int index : HumanGame.additionOrder(KingsTableRules.SEATS)) {
                    LegacyDuel.seat(game, match, players.get(index), decks.get(index));
                }
                List<UUID> ids = players.stream().map(Player::getId).toList();
                format.seatTeams(game, ids);
                game.addTableEventListener(event -> {
                    if (TRACE && event.getMessage() != null && !event.getMessage().isBlank()) {
                        System.out.println("TRACE " + ward + " T" + game.getTurnNum() + " " + event.getMessage()
                            .replaceAll("<[^>]+>", ""));
                    }
                    if (game.getTurnNum() != lastTurn[0]) {
                        lastTurn[0] = game.getTurnNum();
                        if (ids.get(KING_A).equals(game.getActivePlayerId())) {
                            ownTurns[0]++;
                        }
                    }
                    Player you = game.getPlayer(ids.get(KING_A));
                    if (you != null && ownTurns[0] > 0 && firstHit[0] == 0 && you.getLife() < 40) {
                        firstHit[0] = ownTurns[0];
                    }
                });
                // A King chosen at random takes the first turn, as in a game the engine serves.
                UUID first = ids.get(RandomUtil.nextBoolean() ? KING_A : KING_B);
                game.setStartingPlayerId(first);
                game.start(first);
                Player you = game.getPlayer(ids.get(KING_A));
                Player them = game.getPlayer(ids.get(KING_B));
                // 809.5: a King out loses their team the game; both at once is a draw.
                String outcome = !game.hasEnded() || game.getTurnNum() > turnCap ? "turn_cap"
                    : you.hasLost() && them.hasLost() ? "draw"
                    : them.hasLost() ? "reference" : you.hasLost() ? "warden" : "none";
                result.set(new Played(ward, reference.id(), seed, outcome, game.getTurnNum(),
                    firstHit[0] == 0 ? null : firstHit[0], null, you.getLife(), them.getLife(), 0));
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
                null, 0, 0, millis);
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
