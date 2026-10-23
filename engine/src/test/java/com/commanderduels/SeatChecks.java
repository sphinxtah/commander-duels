package com.commanderduels;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import mage.MageObject;
import mage.cards.Card;
import mage.cards.Cards;
import mage.constants.CommanderCardType;
import mage.constants.Zone;
import mage.game.ExileZone;
import mage.game.Game;
import mage.game.GameCommanderImpl;
import mage.game.command.CommandObject;
import mage.game.events.TableEvent;
import mage.game.permanent.Permanent;
import mage.game.stack.Spell;
import mage.game.stack.StackObject;
import mage.players.Player;
import mage.watchers.common.CommanderInfoWatcher;
import mage.watchers.common.CommanderPlaysCountWatcher;

/**
 * Checks every view and prompt published to every human seat, on the game thread, against XMage's
 * own state. Failures are collected rather than thrown (throwing would break the game). Besides the
 * concealed-information checks it compares counts, life totals and each commander's zone, tax and
 * commander damage with XMage, reads the log each seat would be served at every new line, fails on
 * any error XMage recovered from, and records which Commander situations the games reached.
 */
class SeatChecks implements HumanGame.Hooks {
    static final Path DECKS = Path.of("decks");
    private static final Pattern UUIDS =
        Pattern.compile("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}");
    private static final Pattern REFS = Pattern.compile("o[0-9a-f]{16}");
    /** Each Commander fixture's colour identity, written down independently of XMage. */
    static final Map<String, String> IDENTITIES = Map.of(
        "commander-mono-white-soldiers", "W",
        "commander-mono-blue-flyers", "U",
        "commander-mono-red-raiders", "R",
        "commander-mono-green-stompers", "G");

    private final HumanGameRequest request;
    /** By human seat: card names only other seats' decks contain, so naming one discloses a concealed card. */
    private final Map<Integer, Set<String>> concealedNames = new HashMap<>();
    private final Set<String> concealedFromSomeone = new HashSet<>();
    final Set<String> everPublic = ConcurrentHashMap.newKeySet();
    final List<String> failures = new CopyOnWriteArrayList<>();
    final AtomicInteger viewsChecked = new AtomicInteger();
    final AtomicInteger spectatorViewsChecked = new AtomicInteger();
    /** When each spectator view was published, for the delay checks. */
    final List<Map.Entry<Long, SeatView>> spectatorHistory = new CopyOnWriteArrayList<>();
    final AtomicInteger logLinesChecked = new AtomicInteger();
    /** Commander situations the views showed, for coverage reports. */
    final Set<String> reached = ConcurrentHashMap.newKeySet();
    final AtomicInteger maxTax = new AtomicInteger();
    final AtomicInteger maxCommanderDamage = new AtomicInteger();
    /** Log lines naming a card that was not public yet; it must be public by the next event. */
    private final List<String[]> pending = new CopyOnWriteArrayList<>();
    /** By human seat: card names the views published to that seat have shown. */
    private final Map<Integer, Set<String>> shown = new ConcurrentHashMap<>();
    /** By human seat: how many log lines served to that seat have been checked. */
    private final Map<Integer, Integer> servedChecked = new ConcurrentHashMap<>();
    private final Map<String, Pattern> phrases = new ConcurrentHashMap<>();
    volatile List<UUID> seatIds;
    /** The game, set before it starts, so the log each seat would be served can be read. */
    volatile HumanGame game;

    SeatChecks(HumanGameRequest request) throws IOException {
        this.request = request;
        for (int seat = 0; seat < request.seats().size(); seat++) {
            if (!request.seats().get(seat).human()) {
                continue;
            }
            Set<String> names = new HashSet<>();
            for (int other = 0; other < request.seats().size(); other++) {
                if (other != seat) {
                    names.addAll(deckNames(request.seats().get(other)));
                }
            }
            names.removeAll(deckNames(request.seats().get(seat)));
            concealedNames.put(seat, names);
            concealedFromSomeone.addAll(names);
        }
        // A spectator may know no card until it is public.
        Set<String> all = new HashSet<>();
        for (HumanGameRequest.Seat seat : request.seats()) {
            all.addAll(deckNames(seat));
        }
        concealedNames.put(-1, all);
        concealedFromSomeone.addAll(all);
    }

    /** Card names in a seat's deck: its deck list, or its fixture deck file. */
    static Set<String> deckNames(HumanGameRequest.Seat seat) throws IOException {
        if (seat.custom() == null) {
            return deckNames(seat.deck());
        }
        Set<String> names = new HashSet<>(seat.custom().commanders());
        seat.custom().cards().forEach(entry -> names.add(entry.name()));
        return names;
    }

    /** Card names in a fixture deck file, including the commander's SB: line. */
    static Set<String> deckNames(String deck) throws IOException {
        Set<String> names = new HashSet<>();
        for (String line : Files.readAllLines(DECKS.resolve(deck + ".txt"))) {
            String entry = line.startsWith("SB:") ? line.substring(3).trim() : line;
            if (!entry.isBlank() && !entry.startsWith("//")) {
                names.add(entry.substring(entry.indexOf(' ') + 1).trim());
            }
        }
        return names;
    }

    @Override
    public void beforeStart(Game game, List<UUID> ids) {
        seatIds = ids;
        game.addTableEventListener(event -> {
            if (event.getEventType() == TableEvent.EventType.ERROR) {
                // XMage rolls back and plays on after most exceptions, including ones thrown by the
                // engine's view and prompt builders or by these checks: the game would still finish.
                fail("XMage recovered from a game error: " + MatchLog.plain(event.getMessage())
                    + (event.getException() == null ? "" : " " + event.getException()));
            }
            everPublic.addAll(publicNames(game));
            settle();
            if (event.getEventType() == TableEvent.EventType.INFO) {
                logLinesChecked.incrementAndGet();
                String text = MatchLog.plain(event.getMessage());
                for (String name : concealedFromSomeone) {
                    if (text.contains(name) && !everPublic.contains(name)) {
                        // XMage logs some moves (a discard, for instance) just before making them.
                        pending.add(new String[]{name, text});
                    }
                }
                // The line is in the log now; no seat may be served it before its view shows the card.
                servedLogs();
            }
        });
    }

    /**
     * Each seat's log stops where its view was built, so every card a line served to the seat
     * names must be one that the seat's views have shown: public in the same view, or before it.
     */
    void servedLogs() {
        HumanGame running = game;
        if (running == null) {
            return;
        }
        for (int seat : running.humanSeats()) {
            Set<String> seen = shown.getOrDefault(seat, Set.of());
            HumanGame.Snapshot snapshot;
            do {
                try {
                    snapshot = running.snapshot(seat, -1, 0, servedChecked.getOrDefault(seat, 0));
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    return;
                }
                for (HumanGame.LogLine line : snapshot.log()) {
                    for (String name : concealedNames.getOrDefault(seat, Set.of())) {
                        if (!seen.contains(name) && phrase(name).matcher(line.text()).find()) {
                            fail("the log served to seat " + seat + " names " + name + " before its view showed"
                                + " it (revision " + snapshot.revision() + "): " + line.text());
                        }
                    }
                }
                servedChecked.put(seat, snapshot.logFrom() + snapshot.log().size());
            } while (snapshot.log().size() == HumanGame.MAX_LOG_PAGE);
        }
    }

    /** A name as a whole phrase, as {@link #names} matches free text. */
    private Pattern phrase(String name) {
        return phrases.computeIfAbsent(name,
            key -> Pattern.compile("(?<![\\w-])" + Pattern.quote(key) + "(?![\\w-])"));
    }

    /** Names a view shows as public: as a client would read them from the view alone. */
    private static Set<String> shownNames(SeatView view) {
        Set<String> names = new HashSet<>();
        view.battlefield().forEach(permanent -> names.add(permanent.card().name()));
        view.stack().forEach(item -> names.add(item.name()));
        List<SeatView.PlayerState> players = new ArrayList<>(view.opponents());
        if (view.you() != null) {
            players.add(view.you());
        }
        for (SeatView.PlayerState player : players) {
            player.graveyard().forEach(card -> names.add(card.name()));
            player.exile().forEach(card -> names.add(card.name()));
            player.commandZone().forEach(card -> names.add(card.name()));
            if (player.hand() != null) {
                player.hand().forEach(card -> names.add(card.name()));
            }
        }
        view.revealed().forEach(group -> group.cards().forEach(card -> names.add(card.name())));
        names.remove(null);
        return names;
    }

    /**
     * Log lines from the previous event must name only cards that are now public. Once the game has
     * finished, the whole log served with the final views is checked too.
     */
    void settle() {
        for (String[] line : pending) {
            if (!everPublic.contains(line[0])) {
                fail("log line names the concealed " + line[0] + ": " + line[1]);
            }
        }
        pending.clear();
        HumanGame running = game;
        if (running != null && running.finished()) {
            servedLogs();
        }
    }

    @Override
    public void published(Game game, ObjectRefs refs, int seat, SeatView view, PromptView prompt) {
        viewsChecked.incrementAndGet();
        shown.computeIfAbsent(seat, key -> ConcurrentHashMap.newKeySet()).addAll(shownNames(view));
        check(game, refs, seat, view, prompt);
        servedLogs();
    }

    @Override
    public void failed(RuntimeException error) {
        fail("building the final views failed: " + error);
    }

    /** A spectator's view must show public information only. */
    @Override
    public void spectated(Game game, ObjectRefs refs, SeatView view) {
        spectatorViewsChecked.incrementAndGet();
        spectatorHistory.add(Map.entry(System.nanoTime(), view));
        if (view.seat() != null || view.you() != null || !view.hand().isEmpty() || !view.lookedAt().isEmpty()
                || !view.messages().isEmpty()) {
            fail("a spectator view has a seat, a hand, looked-at cards or messages");
        }
        check(game, refs, -1, view, null);
    }

    /** Checks one view for a seat, or for a spectator when {@code seat} is -1. */
    private void check(Game game, ObjectRefs refs, int seat, SeatView view, PromptView prompt) {
        everPublic.addAll(publicNames(game));
        settle();
        String json = EngineServer.JSON.toJson(view) + (prompt == null ? "" : EngineServer.JSON.toJson(prompt));
        UUID viewer = seat < 0 ? null : seatIds.get(seat);

        Matcher uuids = UUIDS.matcher(json);
        while (uuids.find()) {
            if (prompt == null || !uuids.group().equals(prompt.id())) {
                fail("an XMage UUID reached seat " + seat + ": " + uuids.group());
            }
        }

        Set<UUID> hidden = hiddenFrom(game, viewer);
        objectIds(game, refs, seat, EngineServer.JSON.toJson(view), hidden, "view");
        if (prompt != null) {
            // Searching your own library shows it to you: its cards may appear in your prompts.
            Set<UUID> hiddenFromPrompt = new HashSet<>(hidden);
            hiddenFromPrompt.removeAll(game.getPlayer(viewer).getLibrary().getCardList());
            objectIds(game, refs, seat, EngineServer.JSON.toJson(prompt), hiddenFromPrompt, prompt.kind() + " prompt");
        }

        Set<String> concealed = new HashSet<>(concealedNames.getOrDefault(seat, Set.of()));
        concealed.removeAll(everPublic);
        // 810.5: a teammate's hand is the seat's to see; its library stays concealed.
        concealed.removeAll(teammateHandNames(game, viewer));
        if (!concealed.isEmpty()) {
            names(EngineServer.JSON.toJsonTree(view), concealed, seat, "view");
            if (prompt != null) {
                names(EngineServer.JSON.toJsonTree(prompt), concealed, seat, prompt.kind() + " prompt");
            }
        }

        check(seat < 0 ? view.seat() == null : Integer.valueOf(seat).equals(view.seat()), "view seat");
        check(view.opponents().size() == seatIds.size() - (seat < 0 ? 0 : 1), "one entry per opponent");
        List<SeatView.PlayerState> players = new ArrayList<>(view.opponents());
        if (view.you() != null) {
            players.add(view.you());
        }
        int previous = -1;
        for (SeatView.PlayerState opponent : view.opponents()) {
            check(opponent.seat() != seat && opponent.seat() > previous, "opponents in seat order");
            previous = opponent.seat();
        }
        for (SeatView.PlayerState state : players) {
            Player player = game.getPlayer(seatIds.get(state.seat()));
            String where = " of seat " + state.seat() + " in seat " + seat + "'s view, turn " + game.getTurnNum()
                + " " + game.getTurnStepType() + ": view ";
            check(state.handCount() == player.getHand().size(),
                "hand count" + where + state.handCount() + ", XMage " + player.getHand().size());
            check(state.libraryCount() == player.getLibrary().size(),
                "library count" + where + state.libraryCount() + ", XMage " + player.getLibrary().size());
            check(state.life() == player.getLife(), "life" + where + state.life() + ", XMage " + player.getLife());
            check(state.lost() == player.hasLost(), "lost flag" + where + state.lost() + ", XMage " + player.hasLost());
            if (state.lost()) {
                reached.add("eliminated player shown");
            }
            commanders(game, refs, viewer, state, player);
            teams(game, refs, viewer, state, player, where);
        }
        Player you = viewer == null ? null : game.getPlayer(viewer);
        if (you != null) {
            check(view.hand().size() == you.getHand().getCards(game).size(), "own hand size of seat " + seat
                + ": view " + view.hand().size() + ", XMage " + you.getHand().getCards(game).size() + " cards of "
                + you.getHand().size());
            for (SeatView.CardInfo card : view.hand()) {
                UUID id = refs.resolve(card.id()).orElse(null);
                check(id != null && you.getHand().contains(id) && !card.hidden(), "own hand card " + card.name());
            }
        }
        for (SeatView.PermanentInfo permanent : view.battlefield()) {
            UUID id = refs.resolve(permanent.id()).orElse(null);
            Permanent actual = id == null ? null : game.getPermanent(id);
            check(actual != null && seatIds.indexOf(actual.getControllerId()) == permanent.controllerSeat()
                && seatIds.indexOf(actual.getOwnerId()) == permanent.ownerSeat(), "controller and owner of "
                + permanent.card().name() + ": view " + permanent.controllerSeat() + "/" + permanent.ownerSeat()
                + ", XMage " + (actual == null ? "gone" : seatIds.indexOf(actual.getControllerId()) + "/"
                + seatIds.indexOf(actual.getOwnerId())) + ", turn " + game.getTurnNum());
            if (permanent.controllerSeat() != permanent.ownerSeat()) {
                reached.add("permanent controlled by a non-owner");
            }
        }
        if (prompt != null) {
            for (PromptView.Option option : prompt.options()) {
                check(option.seat() == null || (option.seat() >= 0 && option.seat() < seatIds.size()),
                    "option seat in range");
            }
        }
    }

    private void objectIds(Game game, ObjectRefs refs, int seat, String json, Set<UUID> hidden, String where) {
        Matcher ids = REFS.matcher(json);
        while (ids.find()) {
            UUID id = refs.resolve(ids.group()).orElse(null);
            if (id == null) {
                fail("unknown object id " + ids.group());
            } else if (hidden.contains(id)) {
                fail("concealed object disclosed to seat " + seat + ": " + describe(game, id) + " in " + where);
            }
        }
    }

    /**
     * A concealed card's name must not appear as a card name or an object option's label, nor as a
     * whole phrase in free text. Type lines are not checked: subtypes such as "Ogre Warrior" can
     * equal a card name.
     */
    private void names(JsonElement element, Set<String> concealed, int seat, String where) {
        if (element.isJsonArray()) {
            element.getAsJsonArray().forEach(item -> names(item, concealed, seat, where));
            return;
        }
        if (!element.isJsonObject()) {
            return;
        }
        JsonObject object = element.getAsJsonObject();
        for (String key : List.of("name", "label")) {
            JsonElement value = object.get(key);
            boolean objectOption = !key.equals("label") || (object.has("object_id") && !object.get("object_id")
                .isJsonNull());
            if (value != null && value.isJsonPrimitive() && objectOption && concealed.contains(value.getAsString())) {
                fail("the concealed " + value.getAsString() + " was named to seat " + seat + " in " + where);
            }
        }
        for (String key : List.of("message", "detail", "text", "messages")) {
            JsonElement value = object.get(key);
            List<String> texts = new ArrayList<>();
            if (value != null && value.isJsonPrimitive()) {
                texts.add(value.getAsString());
            } else if (value != null && value.isJsonArray()) {
                value.getAsJsonArray().forEach(item -> texts.add(item.isJsonPrimitive() ? item.getAsString() : ""));
            }
            for (String text : texts) {
                for (String name : concealed) {
                    if (Pattern.compile("(?<![\\w-])" + Pattern.quote(name) + "(?![\\w-])").matcher(text).find()) {
                        fail("the concealed " + name + " was named to seat " + seat + " in " + where + ": " + text);
                    }
                }
            }
        }
        object.entrySet().forEach(entry -> {
            if (entry.getValue().isJsonObject() || entry.getValue().isJsonArray()) {
                names(entry.getValue(), concealed, seat, where);
            }
        });
    }

    /** Each commander's zone, casts, tax and commander damage must be exactly XMage's. */
    private void commanders(Game game, ObjectRefs refs, UUID viewer, SeatView.PlayerState state, Player player) {
        if (!(game instanceof GameCommanderImpl)) {
            check(state.colorIdentity() == null && state.commanders().isEmpty(), "no commanders outside Commander");
            return;
        }
        CommanderPlaysCountWatcher plays = game.getState().getWatcher(CommanderPlaysCountWatcher.class);
        Set<UUID> commanderIds = game.getCommandersIds(player, CommanderCardType.COMMANDER_OR_OATHBREAKER, false);
        check(commanderIds.isEmpty() ? state.colorIdentity() == null
                : IDENTITIES.get(request.seats().get(state.seat()).deck()).equals(state.colorIdentity()),
            "colour identity of seat " + state.seat() + ": " + state.colorIdentity());
        if (!player.hasLeft()) {
            check(state.commanders().size() == commanderIds.size(), "one entry per commander of seat " + state.seat());
        }
        for (SeatView.CommanderState commander : state.commanders()) {
            UUID id = commanderIds.stream().filter(candidate -> {
                Card card = game.getCard(candidate);
                return card != null && card.getName().equals(commander.name());
            }).findFirst().orElse(null);
            if (id == null) {
                check(commander.zone().equals("outside") && commander.objectId() == null,
                    "a commander that left the game");
                continue;
            }
            int casts = plays.getPlaysCount(id);
            check(commander.castCount() == casts && commander.tax() == 2 * casts,
                "commander tax of " + commander.name() + ": view " + commander.tax() + ", XMage " + (2 * casts));
            Map<Integer, Integer> expected = new HashMap<>();
            CommanderInfoWatcher watcher = game.getState().getWatcher(CommanderInfoWatcher.class, id);
            if (watcher != null) {
                watcher.getDamageToPlayer().forEach((playerId, amount) -> {
                    if (amount > 0) {
                        expected.put(seatIds.indexOf(playerId), amount);
                    }
                });
            }
            Map<Integer, Integer> shown = new HashMap<>();
            commander.damageDealt().forEach(entry -> shown.put(entry.seat(), entry.damage()));
            check(shown.equals(expected), "commander damage of " + commander.name() + ": view " + shown
                + ", XMage " + expected);
            Zone zone = game.getState().getZone(id);
            String zoneName = zone == null ? "outside" : switch (zone) {
                case COMMAND -> "command";
                case BATTLEFIELD -> "battlefield";
                case STACK -> "stack";
                case GRAVEYARD -> "graveyard";
                case EXILED -> "exile";
                case HAND -> "hand";
                case LIBRARY -> "library";
                default -> "outside";
            };
            boolean owner = player.getId().equals(viewer);
            if (!owner && (zone == Zone.HAND || zone == Zone.LIBRARY)) {
                check(commander.zone().equals("hidden") && commander.objectId() == null,
                    "a commander in a concealed zone is hidden from other seats");
            } else {
                check(commander.zone().equals(zoneName), "commander zone of " + commander.name() + ": view "
                    + commander.zone() + ", XMage " + zoneName);
            }
            if (commander.objectId() != null) {
                UUID object = refs.resolve(commander.objectId()).orElse(null);
                Spell spell = zone == Zone.STACK ? game.getStack().getSpell(id, false) : null;
                check(object != null && (object.equals(id) || (spell != null && object.equals(spell.getId()))),
                    "commander object of " + commander.name());
            }
            reached.add("commander zone " + commander.zone());
            maxTax.accumulateAndGet(commander.tax(), Math::max);
            for (SeatView.CommanderDamage damage : commander.damageDealt()) {
                maxCommanderDamage.accumulateAndGet(damage.damage(), Math::max);
                Permanent permanent = game.getPermanent(id);
                if (permanent != null && !permanent.isControlledBy(player.getId())) {
                    reached.add("commander damage while controlled by another player");
                }
            }
        }
    }

    /**
     * Two-Headed Giant: each player's team is the format's, teammates show the same (shared) life
     * total, and a hand is shown only to its owner's teammate, card for card as XMage holds it.
     */
    private void teams(Game game, ObjectRefs refs, UUID viewer, SeatView.PlayerState state, Player player,
                       String where) {
        if (!request.format().teams()) {
            check(state.team() == null && state.hand() == null, "no teams or shown hands outside team games");
            return;
        }
        check(request.format().teamOf(state.seat()).equals(state.team()), "team" + where + state.team());
        for (UUID teammateId : game.getTeammates(player.getId())) {
            Player teammate = game.getPlayer(teammateId);
            check(teammate.getLife() == player.getLife(), "shared life" + where + player.getLife() + ", teammate "
                + teammate.getLife());
        }
        boolean teammate = viewer != null && game.getTeammates(viewer).contains(player.getId());
        if (!teammate) {
            check(state.hand() == null, "a hand shown to someone not on its owner's team" + where);
            return;
        }
        reached.add("teammate hand shown");
        List<UUID> shownHand = state.hand().stream().map(card -> refs.resolve(card.id()).orElse(null)).toList();
        check(shownHand.size() == player.getHand().size() && player.getHand().containsAll(shownHand)
            && state.hand().stream().noneMatch(SeatView.CardInfo::hidden), "teammate's hand" + where + shownHand.size()
            + " cards, XMage " + player.getHand().size());
    }

    /** Names of the cards in the viewer's teammates' hands, which the viewer may see (810.5). */
    private static Set<String> teammateHandNames(Game game, UUID viewer) {
        Set<String> names = new HashSet<>();
        if (viewer != null) {
            for (UUID teammateId : game.getTeammates(viewer)) {
                game.getPlayer(teammateId).getHand().getCards(game).forEach(card -> names.add(card.getName()));
            }
        }
        return names;
    }

    private void check(boolean condition, String what) {
        if (!condition) {
            fail("view disagrees with XMage: " + what);
        }
    }

    void fail(String message) {
        String thread = Thread.currentThread().getName();
        if (failures.size() < 50) {
            failures.add(thread.startsWith("GAME") ? message : message + " (on thread " + thread + ")");
        }
    }

    /**
     * Cards whose identity the seat may not know: other players' hands (but a teammate's, 810.5) and
     * every library.
     */
    private static Set<UUID> hiddenFrom(Game game, UUID viewer) {
        Set<UUID> hidden = new HashSet<>();
        for (Player player : game.getPlayers().values()) {
            hidden.addAll(player.getLibrary().getCardList());
            if (!player.getId().equals(viewer) && (viewer == null || !game.getTeammates(viewer).contains(player.getId()))) {
                hidden.addAll(player.getHand());
            }
        }
        for (Cards cards : game.getState().getRevealed().values()) {
            hidden.removeAll(cards);
        }
        if (viewer != null) {
            for (Cards cards : game.getState().getLookedAt(viewer).values()) {
                hidden.removeAll(cards);
            }
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
        for (CommandObject object : game.getState().getCommand()) {
            names.add(object.getName());
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
