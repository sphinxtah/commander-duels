package com.commanderduels;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Random;
import java.util.Set;
import java.util.TreeMap;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import mage.MageObject;
import mage.cards.Card;
import mage.cards.Cards;
import mage.game.ExileZone;
import mage.game.Game;
import mage.game.events.TableEvent;
import mage.game.permanent.Permanent;
import mage.game.stack.StackObject;
import mage.players.Player;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;

/**
 * Real human-versus-bot games: a scripted player answers every prompt through the seat API, and
 * every view and prompt published to the seat is checked, on the game thread, against XMage's own
 * state. Needs ./db (the card database) and ./decks.
 */
class HumanGameTest {
    static final Path DECKS = Path.of("decks");
    private static final Pattern UUIDS =
        Pattern.compile("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}");
    private static final Pattern REFS = Pattern.compile("o[0-9a-f]{16}");
    /** Prompt kinds seen across the scripted games, and XMage requests this version does not type. */
    private static final Map<String, Integer> KINDS = new ConcurrentHashMap<>();
    private static final Set<String> UNSUPPORTED = ConcurrentHashMap.newKeySet();

    @BeforeAll
    static void loadCards() {
        assertTrue(CardDatabase.load().printings() > 50_000);
    }

    @AfterAll
    static void everyFixturePromptFamilyWasTyped() {
        System.out.println("Prompt kinds answered: " + new TreeMap<>(KINDS));
        assertTrue(UNSUPPORTED.isEmpty(), "XMage requests the fixture decks reach but no prompt types: " + UNSUPPORTED);
        for (String kind : List.of("priority", "mulligan", "choose_target", "pay_mana", "declare_attackers",
                "declare_blockers")) {
            assertTrue(KINDS.containsKey(kind), "the scripted games never saw a " + kind + " prompt");
        }
    }

    /** Checks run for every published view; failures are collected (throwing would break the game). */
    static final class LeakCheck implements HumanGame.Hooks {
        final Set<String> opponentOnlyNames;
        final Set<String> everPublic = ConcurrentHashMap.newKeySet();
        final List<String> failures = new CopyOnWriteArrayList<>();
        final AtomicInteger viewsChecked = new AtomicInteger();
        final AtomicInteger logLinesChecked = new AtomicInteger();
        /** Log lines naming a card that was not public yet; it must be public by the next event. */
        private final List<String[]> pending = new CopyOnWriteArrayList<>();
        volatile UUID humanId;
        volatile UUID botId;

        LeakCheck(String humanDeck, String botDeck) throws Exception {
            opponentOnlyNames = deckNames(botDeck);
            opponentOnlyNames.removeAll(deckNames(humanDeck));
        }

        @Override
        public void beforeStart(Game game, List<UUID> seatIds) {
            humanId = seatIds.get(0);
            botId = seatIds.get(1);
            game.addTableEventListener(event -> {
                everPublic.addAll(publicNames(game));
                settle();
                if (event.getEventType() == TableEvent.EventType.INFO) {
                    logLinesChecked.incrementAndGet();
                    String text = MatchLog.plain(event.getMessage());
                    for (String name : opponentOnlyNames) {
                        if (text.contains(name) && !everPublic.contains(name)) {
                            // XMage logs some moves (a discard, for instance) just before making them.
                            pending.add(new String[]{name, text});
                        }
                    }
                }
            });
        }

        /** Log lines from the previous event must name only cards that are now public. */
        private void settle() {
            for (String[] line : pending) {
                if (!everPublic.contains(line[0])) {
                    fail("log line names the concealed " + line[0] + ": " + line[1]);
                }
            }
            pending.clear();
        }

        @Override
        public void published(Game game, ObjectRefs refs, SeatView view, PromptView prompt) {
            viewsChecked.incrementAndGet();
            everPublic.addAll(publicNames(game));
            settle();
            String json = EngineServer.JSON.toJson(view) + (prompt == null ? "" : EngineServer.JSON.toJson(prompt));

            Matcher uuids = UUIDS.matcher(json);
            while (uuids.find()) {
                if (prompt == null || !uuids.group().equals(prompt.id())) {
                    fail("an XMage UUID reached the seat: " + uuids.group());
                }
            }

            Set<UUID> hidden = hiddenFromHuman(game);
            Matcher ids = REFS.matcher(json);
            while (ids.find()) {
                UUID id = refs.resolve(ids.group()).orElse(null);
                if (id == null) {
                    fail("unknown object id " + ids.group());
                } else if (hidden.contains(id)) {
                    fail("concealed object disclosed: " + describe(game, id) + " in "
                        + (prompt == null ? "view" : prompt.kind() + " prompt"));
                }
            }

            for (String name : opponentOnlyNames) {
                if (json.contains(name) && !everPublic.contains(name)) {
                    fail("the concealed " + name + " was named to the seat");
                }
            }

            Player human = game.getPlayer(humanId);
            Player bot = game.getPlayer(botId);
            check(view.opponent().handCount() == bot.getHand().size(), "opponent hand count");
            check(view.opponent().libraryCount() == bot.getLibrary().size(), "opponent library count");
            check(view.you().libraryCount() == human.getLibrary().size(), "own library count");
            check(view.hand().size() == human.getHand().size(), "own hand size");
            for (SeatView.CardInfo card : view.hand()) {
                UUID id = refs.resolve(card.id()).orElse(null);
                check(id != null && human.getHand().contains(id) && !card.hidden(), "own hand card " + card.name());
            }
        }

        private void check(boolean condition, String what) {
            if (!condition) {
                fail("view disagrees with XMage: " + what);
            }
        }

        private void fail(String message) {
            if (failures.size() < 50) {
                failures.add(message);
            }
        }

        /** Cards whose identity the human seat may not know: the bot's hand and both libraries. */
        private Set<UUID> hiddenFromHuman(Game game) {
            Set<UUID> hidden = new HashSet<>(game.getPlayer(botId).getHand());
            hidden.addAll(game.getPlayer(botId).getLibrary().getCardList());
            hidden.addAll(game.getPlayer(humanId).getLibrary().getCardList());
            for (Cards cards : game.getState().getRevealed().values()) {
                hidden.removeAll(cards);
            }
            for (Cards cards : game.getState().getLookedAt(humanId).values()) {
                hidden.removeAll(cards);
            }
            return hidden;
        }

        private static Set<String> publicNames(Game game) {
            Set<String> names = new HashSet<>();
            for (Permanent permanent : game.getBattlefield().getAllPermanents()) {
                if (!permanent.isFaceDown(game)) {
                    names.add(permanent.getName());
                }
            }
            for (StackObject stackObject : game.getStack()) {
                names.add(stackObject.getName());
                MageObject source = game.getObject(stackObject.getSourceId());
                if (source != null) {
                    names.add(source.getName());
                }
            }
            for (Player player : game.getPlayers().values()) {
                for (Card card : player.getGraveyard().getCards(game)) {
                    names.add(card.getName());
                }
            }
            for (ExileZone zone : game.getExile().getExileZones()) {
                for (Card card : zone.getCards(game)) {
                    if (!card.isFaceDown(game)) {
                        names.add(card.getName());
                    }
                }
            }
            for (Cards cards : game.getState().getRevealed().values()) {
                for (Card card : cards.getCards(game)) {
                    names.add(card.getName());
                }
            }
            return names;
        }

        private static String describe(Game game, UUID id) {
            MageObject object = game.getObject(id);
            return (object == null ? id.toString() : object.getName()) + " in " + game.getState().getZone(id);
        }
    }

    /** Card names in a fixture deck file. */
    static Set<String> deckNames(String deck) throws Exception {
        Set<String> names = new HashSet<>();
        for (String line : Files.readAllLines(DECKS.resolve(deck + ".txt"))) {
            if (!line.isBlank() && !line.startsWith("//")) {
                names.add(line.substring(line.indexOf(' ') + 1).trim());
            }
        }
        return names;
    }

    /** Answers prompts like an eager, slightly random player, so games progress and reach combat. */
    static final class ScriptedSeat {
        private final Random random;
        private int payPromptsInARow;
        boolean customAmounts;

        ScriptedSeat(long seed) {
            random = new Random(seed);
        }

        String choose(PromptView prompt) {
            List<PromptView.Option> options = prompt.options();
            payPromptsInARow = prompt.kind().equals("pay_mana") ? payPromptsInARow + 1 : 0;
            customAmounts = false;
            return switch (prompt.kind()) {
                case "priority" -> {
                    var lands = byAction(options, "play_land");
                    var spells = byAction(options, "cast");
                    if (!lands.isEmpty()) {
                        yield pick(lands);
                    }
                    if (!spells.isEmpty() && random.nextInt(10) < 8) {
                        yield pick(spells);
                    }
                    yield byAction(options, "pass").get(0).id();
                }
                case "mulligan" -> random.nextInt(10) == 0 ? byAction(options, "mulligan").get(0).id()
                    : byAction(options, "keep").get(0).id();
                case "yes_no" -> pick(options);
                case "pay_mana" -> {
                    // Mana XMage could use is spent from the pool automatically, so pool options would
                    // only repeat the request; give up on a payment that is not converging.
                    var sources = byAction(options, "tap_source");
                    yield !sources.isEmpty() && payPromptsInARow <= 6 ? pick(sources)
                        : byAction(options, "cancel").get(0).id();
                }
                case "assign_amounts" -> {
                    customAmounts = random.nextBoolean();
                    yield byAction(options, "suggested").get(0).id();
                }
                case "declare_attackers" -> {
                    var all = byAction(options, "all_attack");
                    var fresh = options.stream().filter(o -> o.action().equals("toggle_attacker") && !o.selected())
                        .toList();
                    if (!all.isEmpty() && random.nextInt(3) == 0) {
                        yield all.get(0).id();
                    }
                    if (!fresh.isEmpty() && random.nextBoolean()) {
                        yield pick(fresh);
                    }
                    yield byAction(options, "done").get(0).id();
                }
                case "declare_blockers" -> {
                    var fresh = options.stream().filter(o -> o.action().equals("toggle_blocker") && !o.selected())
                        .toList();
                    yield !fresh.isEmpty() && random.nextInt(3) == 0 ? pick(fresh)
                        : byAction(options, "done").get(0).id();
                }
                case "choose_target" -> {
                    var done = byAction(options, "done");
                    boolean anySelected = options.stream().anyMatch(PromptView.Option::selected);
                    var fresh = options.stream().filter(o -> o.action().equals("choose") && !o.selected()).toList();
                    var opponent = fresh.stream().filter(o -> Integer.valueOf(1).equals(o.seat())).toList();
                    if ((anySelected || fresh.isEmpty()) && !done.isEmpty()) {
                        yield done.get(0).id();
                    }
                    if (!opponent.isEmpty() && random.nextInt(10) < 7) {
                        yield opponent.get(0).id();
                    }
                    yield fresh.isEmpty() ? pick(options) : pick(fresh);
                }
                default -> throw new IllegalStateException("no policy for " + prompt.kind());
            };
        }

        private String pick(List<PromptView.Option> options) {
            return options.get(random.nextInt(options.size())).id();
        }

        private static List<PromptView.Option> byAction(List<PromptView.Option> options, String action) {
            return options.stream().filter(option -> option.action().equals(action)).toList();
        }
    }

    static SeatCommand answer(HumanGame game, String actionId, long revision, String promptId, String option)
            throws JsonRequest.Invalid {
        return SeatCommand.parse("{\"v\":1,\"game_id\":\"" + game.id() + "\",\"action_id\":\"" + actionId
            + "\",\"expected_revision\":" + revision + ",\"prompt_id\":\"" + promptId
            + "\",\"type\":\"submit_choice\",\"payload\":{\"option_id\":\"" + option + "\"}}", game.id());
    }

    static SeatCommand amounts(HumanGame game, long revision, String promptId, List<Integer> values)
            throws JsonRequest.Invalid {
        return SeatCommand.parse("{\"v\":1,\"game_id\":\"" + game.id() + "\",\"action_id\":\"" + UUID.randomUUID()
            + "\",\"expected_revision\":" + revision + ",\"prompt_id\":\"" + promptId
            + "\",\"type\":\"submit_choice\",\"payload\":{\"amounts\":" + values + "}}", game.id());
    }

    static SeatCommand concede(HumanGame game, long revision) throws JsonRequest.Invalid {
        return SeatCommand.parse("{\"v\":1,\"game_id\":\"" + game.id() + "\",\"action_id\":\"" + UUID.randomUUID()
            + "\",\"expected_revision\":" + revision + ",\"type\":\"concede\",\"payload\":{}}", game.id());
    }

    static HumanGame start(HumanGameRequest request, HumanGame.Hooks hooks) {
        var game = new HumanGame(UUID.randomUUID().toString(), request, DECKS, finished -> {}, hooks);
        game.start();
        return game;
    }

    /** Waits for the next snapshot with an open prompt, or the final one. */
    static HumanGame.Snapshot nextPrompt(HumanGame game, long since) throws InterruptedException {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(60);
        HumanGame.Snapshot snapshot = game.snapshot(since, 10_000, 0);
        while (snapshot.prompt() == null && snapshot.result() == null) {
            assertTrue(System.nanoTime() < deadline, "no prompt within 60 s; status " + snapshot.status());
            snapshot = game.snapshot(snapshot.revision(), 10_000, 0);
        }
        return snapshot;
    }

    static void assertRejected(int status, String code, HumanGame.Reply reply) {
        assertEquals(status, reply.status(), reply.body().toString());
        assertEquals(code, reply.body().get("code"), reply.body().toString());
    }

    @ParameterizedTest(name = "{0} against the bot, seed {1}")
    @CsvSource({
        "legacy-mono-red-burn, 101",
        "legacy-mono-red-burn, 102",
        "legacy-mono-red-burn, 103",
        "legacy-mono-green-creatures, 201",
        "legacy-mono-green-creatures, 202",
        "legacy-mono-green-creatures, 203",
    })
    void scriptedGamesFinishWithoutLeaks(String humanDeck, long seed) throws Exception {
        String botDeck = LegacyDuel.DECKS.stream().filter(deck -> !deck.equals(humanDeck)).findFirst().orElseThrow();
        var check = new LeakCheck(humanDeck, botDeck);
        var seat = new ScriptedSeat(seed);
        HumanGame game = start(new HumanGameRequest(seed, humanDeck, botDeck, 1, 20, 600), check);
        long deadline = System.nanoTime() + TimeUnit.MINUTES.toNanos(4);
        long since = -1;
        int answered = 0;
        boolean probed = false;
        HumanGame.Snapshot snapshot;
        while (true) {
            snapshot = nextPrompt(game, since);
            since = snapshot.revision();
            if (snapshot.result() != null) {
                break;
            }
            assertTrue(System.nanoTime() < deadline, "game did not finish in time");
            PromptView prompt = snapshot.prompt();
            KINDS.merge(prompt.kind(), 1, Integer::sum);
            assertEquals("your_prompt".equals(snapshot.status()), !prompt.kind().equals("unsupported"));
            if (prompt.kind().equals("unsupported")) {
                UNSUPPORTED.add(prompt.xmageQuery() + " (" + prompt.message() + ")");
                assertRejected(409, "unsupported_prompt",
                    game.submit(answer(game, UUID.randomUUID().toString(), since, prompt.id(), "1")));
                assertEquals(200, game.concede(concede(game, since)).status());
                continue;
            }
            String option = seat.choose(prompt);
            if (!probed && prompt.options().size() > 1) {
                probeStaleAnswers(game, snapshot, option);
                probed = true;
            } else if (prompt.kind().equals("assign_amounts") && seat.customAmounts) {
                List<Integer> split = prompt.amounts().entries().stream().map(PromptView.AmountEntry::suggested)
                    .toList();
                List<Integer> tooMany = new ArrayList<>(split);
                tooMany.add(0);
                assertRejected(422, "invalid_amounts", game.submit(amounts(game, since, prompt.id(), tooMany)));
                HumanGame.Reply reply = game.submit(amounts(game, since, prompt.id(), split));
                assertEquals(200, reply.status(), reply.body().toString());
                KINDS.merge("assign_amounts (custom)", 1, Integer::sum);
            } else {
                HumanGame.Reply reply = game.submit(answer(game, UUID.randomUUID().toString(), since, prompt.id(),
                    option));
                assertEquals(200, reply.status(), reply.body().toString());
            }
            answered++;
        }

        HumanGame.Result result = snapshot.result();
        assertEquals("finished", snapshot.status());
        assertTrue(Set.of("completed", "turn_limit").contains(result.kind()), "result " + result);
        assertNull(result.error());
        check.settle();
        assertTrue(check.failures.isEmpty(), "leaks or wrong views: " + check.failures);
        assertTrue(answered > 10, "only " + answered + " prompts answered");
        assertTrue(check.viewsChecked.get() > answered, "views checked " + check.viewsChecked.get());
        assertTrue(check.logLinesChecked.get() > 0);
        assertTrue(snapshot.logCount() > 0);
        assertNotNull(snapshot.view());
        assertTrue(BotMatchRunner.join(game.thread(), 10_000), "game thread still running");
        System.out.printf("%s seed %d: %s after %d turns, %d prompts answered, %d views checked%n", humanDeck, seed,
            result.kind() + (result.winnerSeat() == null ? "" : " (seat " + result.winnerSeat() + " won)"),
            result.turns(), answered, check.viewsChecked.get());
    }

    /** Stale, forged and repeated answers are refused without consuming the open prompt. */
    private static void probeStaleAnswers(HumanGame game, HumanGame.Snapshot snapshot, String option)
            throws Exception {
        long revision = snapshot.revision();
        String promptId = snapshot.prompt().id();
        String other = snapshot.prompt().options().stream().map(PromptView.Option::id)
            .filter(id -> !id.equals(option)).findFirst().orElseThrow();
        assertRejected(409, "stale_prompt",
            game.submit(answer(game, UUID.randomUUID().toString(), revision, UUID.randomUUID().toString(), option)));
        assertRejected(409, "stale_revision",
            game.submit(answer(game, UUID.randomUUID().toString(), revision - 1, promptId, option)));
        assertRejected(422, "invalid_option",
            game.submit(answer(game, UUID.randomUUID().toString(), revision, promptId, "999")));
        assertEquals(promptId, game.snapshot(-1, 0, 0).prompt().id(), "refusals must leave the prompt open");

        String actionId = UUID.randomUUID().toString();
        HumanGame.Reply accepted = game.submit(answer(game, actionId, revision, promptId, option));
        assertEquals(200, accepted.status(), accepted.body().toString());
        assertEquals("accepted", accepted.body().get("status"));
        assertEquals(accepted, game.submit(answer(game, actionId, revision, promptId, option)),
            "a retried action returns its original result");
        assertRejected(409, "action_id_reused", game.submit(answer(game, actionId, revision, promptId, other)));
        assertRejected(409, "stale_prompt",
            game.submit(answer(game, UUID.randomUUID().toString(), revision, promptId, other)));
    }

    @Test
    void concedingEndsTheGameForTheBot() throws Exception {
        HumanGame game = start(new HumanGameRequest(7L, LegacyDuel.DECKS.get(0), LegacyDuel.DECKS.get(1), 1, 20, 600),
            HumanGame.Hooks.NONE);
        HumanGame.Snapshot snapshot = nextPrompt(game, -1);
        assertNull(snapshot.result());
        assertEquals(200, game.concede(concede(game, snapshot.revision())).status());
        HumanGame.Snapshot last = finalSnapshot(game);
        assertEquals("completed", last.result().kind(), last.result().toString());
        assertEquals(1, last.result().winnerSeat());
        assertTrue(last.result().conceded());
        assertNull(last.prompt());
        assertRejected(409, "game_over", game.concede(concede(game, last.revision())));
        assertTrue(BotMatchRunner.join(game.thread(), 10_000));
    }

    @Test
    void closingStopsAGameThatIsWaitingForTheSeat() throws Exception {
        HumanGame game = start(new HumanGameRequest(8L, LegacyDuel.DECKS.get(1), LegacyDuel.DECKS.get(0), 1, 20, 600),
            HumanGame.Hooks.NONE);
        nextPrompt(game, -1);
        Map<String, Object> closed = game.close("closed");
        assertEquals("finished", closed.get("status"), closed.toString());
        HumanGame.Snapshot last = finalSnapshot(game);
        assertEquals("closed", last.result().kind());
        assertNull(last.result().winnerSeat());
        assertFalse(game.thread().isAlive());
        assertEquals("finished", game.close("closed").get("status"), "closing twice is harmless");
    }

    static HumanGame.Snapshot finalSnapshot(HumanGame game) throws InterruptedException {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(30);
        HumanGame.Snapshot snapshot = game.snapshot(-1, 0, 0);
        while (snapshot.result() == null) {
            assertTrue(System.nanoTime() < deadline, "game did not finish; status " + snapshot.status());
            snapshot = game.snapshot(snapshot.revision(), 5_000, 0);
        }
        return snapshot;
    }

    @Test
    void idleGamesAreClosed() throws Exception {
        var games = new HumanGames(DECKS, 1);
        var request = new HumanGameRequest(9L, LegacyDuel.DECKS.get(0), LegacyDuel.DECKS.get(1), 1, 20,
            HumanGameRequest.MIN_IDLE_TIMEOUT_SECONDS);
        HumanGame game = games.create(request).orElseThrow().game();
        assertTrue(games.create(request).isEmpty(), "only one game may run");
        HumanGame.Snapshot last = finalSnapshot(game);
        assertEquals("idle_timeout", last.result().kind());
        assertTrue(BotMatchRunner.join(game.thread(), 10_000));
        assertEquals(0, games.active());
        List<String> created = new ArrayList<>();
        games.create(request).ifPresent(next -> {
            created.add(next.game().id());
            next.game().close("closed");
        });
        assertEquals(1, created.size(), "a slot frees up once the idle game ends");
    }
}
