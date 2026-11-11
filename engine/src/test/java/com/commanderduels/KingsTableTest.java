package com.commanderduels;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import mage.game.Game;
import mage.game.GameCommanderImpl;
import mage.game.combat.CombatGroup;
import mage.game.match.Match;
import mage.game.permanent.Permanent;
import mage.players.Player;
import mage.util.RandomUtil;
import mage.util.ThreadUtils;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

/**
 * King's Table (v0.8.7), the owner's Emperor variant: the acceptance checks of the owner's
 * specification at the engine level. Seats 0 to 5 are team A's Left General, King and Right
 * General, then team B's Right General, King and Left General, in that circular order.
 */
class KingsTableTest {
    private static final List<String> LIFE = KingsTableRules.LIFE;

    @BeforeAll
    static void loadCards() {
        assertTrue(CardDatabase.load().printings() > 50_000);
        Tables.actAsClient();
    }

    /** A seated, unstarted game with six bots, each player's range set as at the start of a turn. */
    private static Seated seated(KingsTableRules rules, long seed) throws Exception {
        RandomUtil.setSeed(seed);
        GameFormat format = GameFormat.kingsTable(rules.commander());
        Game game = format.newGame(KingsTableRules.SEATS, 20, rules);
        Match match = format.newMatch("King's Table test", KingsTableRules.SEATS);
        List<Player> players = new ArrayList<>();
        for (int seat = 0; seat < KingsTableRules.SEATS; seat++) {
            players.add(new FairBot("Bot " + (seat + 1), format.range(seat), 1, FairBot.seedFor(seed, seat)));
        }
        for (int index : HumanGame.additionOrder(players.size())) {
            LegacyDuel.seat(game, match, players.get(index),
                format.loadDeck(SeatChecks.DECKS, format.decks().get(index % format.decks().size())));
        }
        List<UUID> ids = players.stream().map(Player::getId).toList();
        format.seatTeams(game, ids);
        for (Player player : players) {
            player.updateRange(game);
        }
        // As in a game under way, a loss is settled at the next priority (XMage's concede queue), so
        // losses at the same moment are seen together, as state-based actions see them (704.3).
        game.getState().setPriorityPlayerId(ids.get(0));
        return new Seated(game, GameFormat.kingsTableOf(game), ids);
    }

    private record Seated(Game game, KingsTable table, List<UUID> ids) {
        Player player(int seat) {
            return game.getPlayer(ids.get(seat));
        }

        /** The seats the seat's player may attack now. */
        Set<Integer> attackable(int seat) {
            UUID attacker = ids.get(seat);
            List<UUID> inRange = new ArrayList<>(game.getOpponents(attacker, true));
            return Set.copyOf(game.attackablePlayers(attacker, inRange).stream().map(ids::indexOf).toList());
        }

        Set<Integer> inRange(int seat) {
            Player player = player(seat);
            Set<Integer> seats = new java.util.HashSet<>();
            for (int other = 0; other < ids.size(); other++) {
                if (player.hasPlayerInRange(ids.get(other))) {
                    seats.add(other);
                }
            }
            return seats;
        }

        void newTurn() {
            for (UUID id : ids) {
                Player player = game.getPlayer(id);
                if (player.isInGame()) {
                    player.updateRange(game);
                }
            }
        }
    }

    @Test
    void everyCombinationOfSettingsSetsTheTable() throws Exception {
        for (boolean commander : new boolean[] {false, true}) {
            for (String life : LIFE) {
                for (boolean anyone : new boolean[] {false, true}) {
                    var rules = new KingsTableRules(commander, life, anyone);
                    Seated table = seated(rules, 7L);
                    String where = " (" + rules + ")";
                    assertEquals(commander, table.game() instanceof GameCommanderImpl, "deck format" + where);
                    for (int seat = 0; seat < 6; seat++) {
                        int expected = switch (life) {
                            case KingsTableRules.ALL_20 -> 20;
                            case KingsTableRules.ALL_40 -> 40;
                            default -> KingsTableRules.king(seat) ? 40 : 20;
                        };
                        assertEquals(expected, table.game().getStartingLife(table.ids().get(seat)),
                            "seat " + seat + "'s starting life" + where);
                        assertEquals(seat / 3, table.table().teamOf(table.ids().get(seat)), "team" + where);
                    }
                    // Teammates are allies, never opponents.
                    Player general = table.player(0);
                    assertEquals(Set.of(table.ids().get(1), table.ids().get(2)), table.game().getAllies(general.getId()));
                    assertFalse(table.game().isOpponent(general, table.ids().get(1)));
                    assertTrue(table.game().isOpponent(general, table.ids().get(5)));
                    assertTrue(table.game().getTeammates(general.getId()).isEmpty(), "no shared team turns" + where);
                    // Ranges: a General's one seat each way, a King's two (809.4a), around the circle.
                    assertEquals(Set.of(5, 0, 1), table.inRange(0), where);
                    assertEquals(Set.of(5, 0, 1, 2, 3), table.inRange(1), where);
                    assertEquals(Set.of(2, 3, 4, 5, 0), table.inRange(4), where);
                    assertEquals(Set.of(2, 3, 4), table.inRange(3), where);
                    // 809.4b: each General faces the opposing General beside them.
                    assertEquals(Set.of(5), table.attackable(0), where);
                    assertEquals(Set.of(3), table.attackable(2), where);
                    assertEquals(Set.of(2), table.attackable(3), where);
                    assertEquals(Set.of(0), table.attackable(5), where);
                    if (anyone) {
                        // The house rule: either King attacks any opponent, the other King included,
                        // while all four Generals live.
                        assertEquals(Set.of(3, 4, 5), table.attackable(1), where);
                        assertEquals(Set.of(0, 1, 2), table.attackable(4), where);
                    } else {
                        assertEquals(Set.of(), table.attackable(1), "a King cannot attack at the start" + where);
                        assertEquals(Set.of(), table.attackable(4), "a King cannot attack at the start" + where);
                    }
                    // The house rule does not widen spells' and abilities' range.
                    assertFalse(table.player(1).hasPlayerInRange(table.ids().get(4)), "range is range" + where);
                    assertEquals(Set.of(table.ids().get(3), table.ids().get(5)),
                        table.game().getOpponents(table.ids().get(1)), "a King's opponents in range" + where);
                }
            }
        }
    }

    @Test
    void aGeneralLeavingOpensNeighboursAtOnceAndRangeAtTheNextTurn() throws Exception {
        Seated table = seated(new KingsTableRules(true, KingsTableRules.ALL_40, false), 8L);
        // Team A's Right General (seat 2) loses.
        table.player(2).lostForced(table.game());
        assertFalse(table.player(2).isInGame());
        // The game goes on: a General's loss ends nothing.
        assertNull(table.table().over(table.game()), "a General's loss does not end the game");
        // At once: team A's King sits beside team B's Right General, already in the King's range (two
        // seats), so the King may attack them; that General's range is still the turn's.
        assertEquals(Set.of(3), table.attackable(1), "the new neighbour, in the King's range");
        assertEquals(Set.of(), table.attackable(3), "team A's King is not yet in the General's range");
        assertFalse(table.player(3).hasPlayerInRange(table.ids().get(1)));
        // The next turn: ranges skip the seat that left.
        table.newTurn();
        assertTrue(table.player(3).hasPlayerInRange(table.ids().get(1)), "in range from the next turn");
        assertEquals(Set.of(1), table.attackable(3), "now the General may attack the King beside them");
        assertEquals(Set.of(5, 0, 1, 3, 4), table.inRange(1), "the King's two seats each way, skipping seat 2");
        // Eliminating a General gives no one the whole table: team B's Left General still faces only seat 0.
        assertEquals(Set.of(0), table.attackable(5));
    }

    @Test
    void aKingsLossEndsTheGameForTheirWholeTeam() throws Exception {
        Seated table = seated(new KingsTableRules(false, KingsTableRules.ALL_20, false), 9L);
        // A General out first, then their King: the General's team still loses with the King.
        table.player(0).lostForced(table.game());
        assertNull(table.table().over(table.game()));
        table.player(1).lostForced(table.game());
        assertEquals(Boolean.TRUE, table.table().over(table.game()));
        for (int seat = 0; seat < 3; seat++) {
            assertTrue(table.player(seat).hasLost(), "team A's seat " + seat + " lost");
        }
        for (int seat = 3; seat < 6; seat++) {
            assertTrue(table.player(seat).hasWon(), "team B's seat " + seat + " won");
        }
    }

    @Test
    void bothKingsLosingAtOnceIsADraw() throws Exception {
        Seated table = seated(new KingsTableRules(true, KingsTableRules.GENERALS_20_KINGS_40, true), 10L);
        table.player(1).lostForced(table.game());
        table.player(4).lostForced(table.game());
        assertEquals(Boolean.TRUE, table.table().over(table.game()));
        for (int seat = 0; seat < 6; seat++) {
            assertFalse(table.player(seat).hasWon(), "nobody won: seat " + seat);
        }
        assertTrue(table.game().hasEnded());
    }

    @Test
    void theKingsPermissionFollowsTheController() throws Exception {
        // The house rule belongs to the King as attacking player: a General attacks by their own rules,
        // whoever owns the creatures (a deployed King's creature included).
        Seated table = seated(new KingsTableRules(true, KingsTableRules.ALL_40, true), 11L);
        assertEquals(Set.of(3), table.attackable(2), "a General keeps the General's restriction");
        assertEquals(Set.of(3, 4, 5), table.attackable(1));
    }

    /**
     * The house rule's guard (v0.9.7, the campaign's court): a King attacks any opposing General
     * from the start, and the other King only once one of that King's own Generals is out.
     */
    @Test
    void generalsGuardTheirKingFromTheOtherKing() throws Exception {
        Seated table = seated(new KingsTableRules(true, KingsTableRules.ALL_40, true, true), 14L);
        Game game = table.game();
        UUID kingA = table.ids().get(1);
        UUID kingB = table.ids().get(4);
        assertTrue(table.table().guarded(game, kingA));
        assertTrue(table.table().guarded(game, kingB));
        assertFalse(table.table().guarded(game, table.ids().get(0)), "only a King is guarded");
        // At the start: the opposing Generals, not the King behind them. The Generals attack as ever.
        assertEquals(Set.of(3, 5), table.attackable(1), "King A attacks team B's Generals");
        assertEquals(Set.of(0, 2), table.attackable(4), "King B attacks team A's Generals");
        assertEquals(Set.of(5), table.attackable(0));
        assertEquals(Set.of(3), table.attackable(2));
        assertEquals(Set.of(2), table.attackable(3));
        assertEquals(Set.of(0), table.attackable(5));
        game.getCombat().setAttacker(kingA);
        game.getCombat().setDefenders(game);
        assertFalse(game.getCombat().getDefenders().contains(kingB), "the guarded King is no defender");
        assertTrue(game.getCombat().getDefenders().contains(table.ids().get(5)), "a General across the table is");
        game.getCombat().clear();

        // Team B's Right General (seat 3) is defeated: King B is open to King A at once, whichever
        // General it was. King A's own Generals both stand, so King B still cannot attack King A.
        table.player(3).lostForced(game);
        assertNull(table.table().over(game), "a General's loss ends nothing");
        assertFalse(table.table().guarded(game, kingB));
        assertTrue(table.table().guarded(game, kingA));
        assertEquals(Set.of(4, 5), table.attackable(1), "the other King, and the General left");
        assertEquals(Set.of(0, 2), table.attackable(4), "King A is still guarded");
        game.getCombat().setAttacker(kingA);
        game.getCombat().setDefenders(game);
        assertTrue(game.getCombat().getDefenders().contains(kingB), "King B is a defender now");
        Permanent attacker = creature(table, 1);
        assertTrue(game.getCombat().declareAttacker(attacker.getId(), kingB, kingA, game), "the King attacks the King");
        assertTrue(game.inCombatAcrossRange(kingB, kingA), "across range, as the house rule's attacks are");
        game.getCombat().clear();

        // One of King A's Generals is defeated: now King B may attack King A too.
        table.player(0).lostForced(game);
        assertFalse(table.table().guarded(game, kingA));
        assertEquals(Set.of(1, 2), table.attackable(4), "King A, and the General left");
        assertEquals(Set.of(4, 5), table.attackable(1));
    }

    @Test
    void theGuardChangesNothingWithoutTheHouseRule() throws Exception {
        // 809.4b alone already keeps the Kings apart until the Generals on one side are both out,
        // one of each King's: the guard has nothing to add, whatever the request says.
        Seated table = seated(new KingsTableRules(true, KingsTableRules.ALL_40, false, true), 15L);
        assertEquals(Set.of(), table.attackable(1), "a King cannot attack at the start");
        assertEquals(Set.of(), table.attackable(4), "a King cannot attack at the start");
        assertEquals(Set.of(3), table.attackable(2));
        table.player(2).lostForced(table.game());
        table.player(3).lostForced(table.game());
        table.newTurn();
        assertEquals(Set.of(4), table.attackable(1), "the Kings sit beside each other, each a General down");
        assertEquals(Set.of(1), table.attackable(4));
    }

    /** Puts the first creature card of the seat's library onto the battlefield, ready to attack or block. */
    private static Permanent creature(Seated table, int seat) {
        Player player = table.player(seat);
        mage.cards.Card card = player.getLibrary().getCards(table.game()).stream()
            .filter(candidate -> candidate.isCreature(table.game())).findFirst().orElseThrow();
        player.getLibrary().remove(card.getId(), table.game());
        var permanent = new mage.game.permanent.PermanentCard(card, player.getId(), table.game());
        table.game().getBattlefield().addPermanent(permanent);
        table.game().getState().setZone(card.getId(), mage.constants.Zone.BATTLEFIELD);
        permanent.removeSummoningSickness();
        return permanent;
    }

    @Test
    void aKingsAttackAcrossRangeIsAWholeCombatButNotRange() throws Exception {
        Seated table = seated(new KingsTableRules(false, KingsTableRules.ALL_20, true), 12L);
        Game game = table.game();
        UUID kingA = table.ids().get(1);
        UUID kingB = table.ids().get(4);
        Permanent attacker = creature(table, 1);
        Permanent blocker = creature(table, 4);
        game.getCombat().setAttacker(kingA);
        game.getCombat().setDefenders(game);
        assertTrue(game.getCombat().getDefenders().contains(kingB), "the other King is a defender");
        assertFalse(game.getPlayer(kingA).hasPlayerInRange(kingB), "though out of range");
        assertTrue(game.getCombat().declareAttacker(attacker.getId(), kingB, kingA, game), "the King attacks the King");
        // The combat is whole: the two Kings are opponents for it, and the defender blocks with their own.
        assertTrue(game.inCombatAcrossRange(kingB, kingA));
        assertTrue(game.getPlayer(kingB).hasOpponent(kingA, game));
        assertTrue(blocker.canBlock(attacker.getId(), game), "the out-of-range defender can block");
        // A teammate of the defender does not block for them.
        Permanent teammate = creature(table, 3);
        assertFalse(teammate.canBlock(attacker.getId(), game), "players cannot block for teammates");
        // Spells and abilities keep to range: the attack opens no target and no "each opponent".
        var target = new mage.target.TargetPlayer();
        assertFalse(target.possibleTargets(kingB, null, game).contains(kingA), "the defender cannot target the King");
        assertFalse(target.possibleTargets(kingA, null, game).contains(kingB), "nor the King the defender");
        assertFalse(game.getOpponents(kingB).contains(kingA), "effects on each opponent keep to range");
        // Without the attack, nothing joins them.
        game.getCombat().clear();
        assertFalse(game.inCombatAcrossRange(kingB, kingA));
        assertFalse(game.getPlayer(kingB).hasOpponent(kingA, game));
    }

    @Test
    void aDeployedCreatureAttacksByItsNewControllersRules() throws Exception {
        Seated table = seated(new KingsTableRules(false, KingsTableRules.ALL_40, true), 13L);
        Game game = table.game();
        UUID kingA = table.ids().get(1);
        UUID general = table.ids().get(2);
        Permanent creature = creature(table, 1);
        // 804: the King taps it to give it to a teammate in range. The bots never deploy: the ability
        // is the human players' alone.
        var deploy = new KingsTable.DeployAbility();
        deploy.setControllerId(kingA);
        deploy.setSourceId(creature.getId());
        assertFalse(deploy.canActivate(kingA, game).canActivate(), "a bot does not deploy");
        assertTrue(deploy.getTargets().get(0).possibleTargets(kingA, deploy, game).contains(general),
            "a teammate in range may receive it");
        assertFalse(deploy.getTargets().get(0).possibleTargets(kingA, deploy, game).contains(table.ids().get(3)),
            "an opponent may not");
        deploy.getTargets().get(0).add(general, game);
        assertTrue(new KingsTable.Deploy().apply(game, deploy));
        game.processAction();
        assertTrue(creature.isControlledBy(general), "the General controls it");
        assertTrue(creature.isOwnedBy(kingA), "the King still owns it");
        // As the General's, it attacks by the General's rules: their opposing General, not the King.
        game.getCombat().setAttacker(general);
        game.getCombat().setDefenders(game);
        assertFalse(game.getCombat().getDefenders().contains(table.ids().get(4)), "the King's permission is gone");
        assertTrue(game.getCombat().getDefenders().contains(table.ids().get(3)));
    }

    @Test
    void theRequestNamesTheSettings() throws Exception {
        HumanGameRequest request = HumanGameRequest.parse("""
            {"format": "kings_table", "kings_table": {"deck_format": "legacy", "life": "generals_20_kings_40",
             "king_attacks_anyone": true},
             "seats": [{"player": "bot"}, {"player": "human"}, {"player": "bot"}, {"player": "bot"},
                       {"player": "bot"}, {"player": "bot"}]}""", () -> 1L, true);
        assertEquals(GameFormat.KINGS_TABLE_LEGACY, request.format());
        assertEquals(new KingsTableRules(false, KingsTableRules.GENERALS_20_KINGS_40, true), request.kingsTable());
        assertEquals(6, request.seats().size());
        HumanGameRequest defaults = HumanGameRequest.parse("{\"format\": \"kings_table\"}", () -> 1L, true);
        assertEquals(GameFormat.KINGS_TABLE_COMMANDER, defaults.format());
        assertEquals(KingsTableRules.DEFAULT, defaults.kingsTable());
        assertFalse(defaults.kingsTable().guardedKings(), "the guard is off unless the request names it");
        assertEquals(6, defaults.seats().size());
        assertEquals(1, defaults.humanSeats());
        assertEquals(240, defaults.turnCap(), "40 turns for each of the six players (v0.9.7)");
        // The house rule's guard (v0.9.7) is a setting like the others, and the settings echo it.
        HumanGameRequest guarded = HumanGameRequest.parse("{\"format\": \"kings_table\", \"kings_table\": "
            + "{\"king_attacks_anyone\": true, \"guarded_kings\": true}}", () -> 1L, true);
        assertEquals(new KingsTableRules(true, KingsTableRules.ALL_40, true, true), guarded.kingsTable());
        assertTrue(guarded.kingsTable().json().get("guarded_kings").getAsBoolean());
        assertEquals(new HumanGame.KingsTableSettings("commander", KingsTableRules.ALL_40, true, true),
            HumanGame.KingsTableSettings.of(guarded.kingsTable()));
        assertThrows(JsonRequest.Invalid.class, () -> HumanGameRequest.parse(
            "{\"format\": \"kings_table\", \"kings_table\": {\"guarded_kings\": \"yes\"}}", () -> 1L, true));
        assertThrows(JsonRequest.Invalid.class, () -> HumanGameRequest.parse(
            "{\"format\": \"kings_table\", \"seats\": [{\"player\": \"human\"}, {\"player\": \"bot\"}]}", () -> 1L, true));
        assertThrows(JsonRequest.Invalid.class, () -> HumanGameRequest.parse(
            "{\"format\": \"commander\", \"kings_table\": {}}", () -> 1L, true));
        assertThrows(JsonRequest.Invalid.class, () -> HumanGameRequest.parse(
            "{\"format\": \"kings_table\", \"starting_seat\": 0}", () -> 1L, true));
        assertThrows(JsonRequest.Invalid.class, () -> HumanGameRequest.parse(
            "{\"format\": \"kings_table\", \"kings_table\": {\"life\": \"all_30\"}}", () -> 1L, true));
        assertEquals(4, HumanGameRequest.parse("{\"format\": \"kings_table\", \"starting_seat\": 4}", () -> 1L, true)
            .startingSeat());
        // A Legacy deck's sideboard comes along, as in Legacy; a Commander deck has none.
        String withSideboard = """
            {"format": "kings_table", "kings_table": {"deck_format": "%s"},
             "seats": [{"player": "human", "deck_list": {"cards": [{"name": "Mountain", "count": 60}],
                        "sideboard": [{"name": "Shock", "count": 4}]%s}},
                       {"player": "bot"}, {"player": "bot"}, {"player": "bot"}, {"player": "bot"}, {"player": "bot"}]}""";
        assertEquals(4, HumanGameRequest.parse(withSideboard.formatted("legacy", ""), () -> 1L, true).seats().get(0)
            .custom().sideboard().get(0).count());
        assertThrows(JsonRequest.Invalid.class, () -> HumanGameRequest.parse(
            withSideboard.formatted("commander", ", \"commanders\": [\"Krenko, Mob Boss\"]"), () -> 1L, true));
    }

    /**
     * A human King with five bots at the practice table, under every leak check: the teammates'
     * hands shown to the human and nothing of the opponents', each player's role, team, starting
     * life and range in the views, and the settings as the request named them.
     */
    @Test
    void aHumanKingPlaysFiveBots() throws Exception {
        var rules = new KingsTableRules(true, KingsTableRules.GENERALS_20_KINGS_40, true);
        List<String> decks = GameFormat.KINGS_TABLE_COMMANDER.decks();
        List<HumanGameRequest.Seat> seats = new ArrayList<>();
        for (int seat = 0; seat < 6; seat++) {
            String deck = decks.get(seat % decks.size());
            seats.add(seat == 1 ? Tables.human(deck) : Tables.bot(deck));
        }
        var request = new HumanGameRequest(6007L, GameFormat.KINGS_TABLE_COMMANDER, seats, 1, 24, 900, 0, null, null,
            rules);
        var check = new SeatChecks(request);
        var scripted = new ScriptedPlayer(6007L);
        var coverage = new Tables.Coverage();
        HumanGame game = Tables.start(request, check);
        Tables.Played played = Tables.play(game, (seat, prompt, view) -> scripted.choose(prompt, view), 6, coverage);
        coverage.summary().forEach(System.out::println);

        check.settle();
        assertTrue(check.failures.isEmpty(), "leaks or wrong views: " + check.failures);
        assertTrue(coverage.unsupported.isEmpty(), "unsupported: " + coverage.unsupported);
        assertTrue(check.reached.contains("teammate hand shown"), "the human saw a teammate's hand");
        HumanGame.Snapshot last = played.last();
        assertEquals("kings_table", last.settings().format());
        assertEquals("kings_table_commander", last.settings().rulesProfile());
        assertEquals(new HumanGame.KingsTableSettings("commander", KingsTableRules.GENERALS_20_KINGS_40, true, false),
            last.settings().kingsTable());
        SeatView.PlayerState you = last.view().you();
        assertEquals("king", you.role());
        assertEquals(40, you.startingLife());
        assertEquals(0, you.team());
        for (SeatView.PlayerState other : last.view().opponents()) {
            assertEquals(KingsTableRules.role(other.seat()), other.role());
            assertEquals(KingsTableRules.king(other.seat()) ? 40 : 20, other.startingLife());
            assertEquals(KingsTableRules.team(other.seat()), other.team());
            if (other.team() == 0 && !other.lost()) {
                assertTrue(other.hand() != null, "a teammate's hand is the human's to see");
                assertFalse(other.attackable(), "never a teammate");
            } else if (other.team() == 1) {
                assertNull(other.hand(), "an opponent's hand is never shown");
            }
        }
        HumanGame.Result result = last.result();
        assertTrue(Set.of("completed", "turn_limit").contains(result.kind()), "the game finished: " + result);
    }

    /** What a whole bots' game did. */
    record BotGame(String kind, List<Integer> winners, int turns, int firstSeat, Set<String> attacks,
                   List<String> violations, int engineErrors, String criticalError) {}

    /**
     * Six bots play whole games in each deck format, with and without the house rule, and (v0.9.7)
     * under the house rule's guard, as the campaign's court plays. Every attack must go at a player
     * the table's rules allow at that moment, never at a teammate; with the house rule off no King
     * attacks while both their Generals live; under the guard no King attacks a King whose Generals
     * both live; the first turn is a King's; a finished game has a winning team (all its players
     * still in the game) or a draw.
     */
    @Test
    void sixBotsPlayWholeGamesByTheTablesRules() throws Exception {
        int completed = 0;
        int across = 0;
        long seed = 31L;
        List<KingsTableRules> tables = new ArrayList<>();
        for (boolean commander : new boolean[] {false, true}) {
            for (boolean anyone : new boolean[] {false, true}) {
                tables.add(new KingsTableRules(commander, commander ? KingsTableRules.ALL_20 : KingsTableRules.ALL_40,
                    anyone));
            }
        }
        tables.add(new KingsTableRules(true, KingsTableRules.ALL_20, true, true));
        for (KingsTableRules rules : tables) {
            BotGame played = playBots(rules, seed++, 40);
            System.out.println("King's Table bots, " + rules + ": " + played);
            assertEquals(0, played.engineErrors(), "XMage recovered from no error: " + played);
            assertNull(played.criticalError());
            assertTrue(played.violations().isEmpty(), "attacks the rules forbid: " + played.violations());
            assertTrue(KingsTableRules.king(played.firstSeat()), "a King took the first turn: " + played);
            assertFalse(played.attacks().isEmpty(), "the bots attacked");
            if (played.kind().equals("completed")) {
                completed++;
                assertTrue(played.winners().isEmpty()
                    || played.winners().stream().map(KingsTableRules::team).distinct().count() == 1,
                    "one team won: " + played.winners());
            }
            across += (int) played.attacks().stream().filter(attack -> attack.endsWith("across")).count();
        }
        System.out.println("King's Table bots: " + completed + " of " + tables.size() + " games completed, "
            + across + " attacks across range");
    }

    static BotGame playBots(KingsTableRules rules, long seed, int turnCap) throws Exception {
        var outcome = new AtomicReference<BotGame>();
        var failure = new AtomicReference<Throwable>();
        Thread thread = new Thread(() -> {
            try {
                outcome.set(runBots(rules, seed, turnCap));
            } catch (Throwable t) {
                failure.set(t);
            }
        }, ThreadUtils.THREAD_PREFIX_GAME + " kings_table_bots " + seed);
        thread.setDaemon(true);
        thread.start();
        if (!BotMatchRunner.join(thread, TimeUnit.MINUTES.toMillis(8))) {
            BotMatchRunner.stop(thread);
            throw new AssertionError("the bots' game did not finish in eight minutes");
        }
        if (failure.get() != null) {
            throw new AssertionError("the bots' game failed", failure.get());
        }
        return outcome.get();
    }

    private static BotGame runBots(KingsTableRules rules, long seed, int turnCap) throws Exception {
        RandomUtil.setSeed(seed);
        GameFormat format = GameFormat.kingsTable(rules.commander());
        Game game = format.newGame(KingsTableRules.SEATS, turnCap, rules);
        Match match = format.newMatch("King's Table bots", KingsTableRules.SEATS);
        List<Player> players = new ArrayList<>();
        for (int seat = 0; seat < KingsTableRules.SEATS; seat++) {
            players.add(new FairBot("Bot " + (seat + 1), format.range(seat), 1, FairBot.seedFor(seed, seat)));
        }
        for (int index : HumanGame.additionOrder(players.size())) {
            LegacyDuel.seat(game, match, players.get(index),
                format.loadDeck(SeatChecks.DECKS, format.decks().get(index % format.decks().size())));
        }
        List<UUID> ids = players.stream().map(Player::getId).toList();
        format.seatTeams(game, ids);
        KingsTable table = GameFormat.kingsTableOf(game);
        var log = new MatchLog();
        log.attach(game, ids);
        List<String> violations = new CopyOnWriteArrayList<>();
        Set<String> attacks = ConcurrentHashMap.newKeySet();
        game.addTableEventListener(event -> audit(game, table, ids, attacks, violations));
        UUID first = ids.get(RandomUtil.nextBoolean() ? 1 : 4);
        game.setStartingPlayerId(first);
        game.start(first);
        List<Integer> winners = new ArrayList<>();
        for (int seat = 0; seat < ids.size(); seat++) {
            if (game.getPlayer(ids.get(seat)).hasWon()) {
                winners.add(seat);
            }
        }
        String kind = game.hasEnded() ? "completed" : game.getTurnNum() > turnCap ? "turn_limit" : "stopped";
        return new BotGame(kind, winners, Math.min(game.getTurnNum(), turnCap), ids.indexOf(first), Set.copyOf(attacks),
            List.copyOf(violations), log.engineErrors(), log.criticalError());
    }

    /** Each declared attack, checked against the table's rules as they stand. Game thread. */
    private static void audit(Game game, KingsTable table, List<UUID> ids, Set<String> attacks,
                              List<String> violations) {
        UUID attacker = game.getCombat().getAttackingPlayerId();
        if (attacker == null) {
            return;
        }
        List<UUID> inRange = new ArrayList<>(game.getOpponents(attacker, true));
        List<UUID> allowed = table.attackable(game, attacker, inRange);
        for (CombatGroup group : game.getCombat().getGroups()) {
            UUID defender = group.getDefendingPlayerId();
            if (group.getAttackers().isEmpty() || defender == null) {
                continue;
            }
            int from = ids.indexOf(attacker);
            int to = ids.indexOf(defender);
            String attack = game.getTurnNum() + ":" + from + ">" + to;
            if (!attacks.add(attack + (game.getPlayer(attacker).hasPlayerInRange(defender) ? "" : " across"))) {
                continue;
            }
            for (UUID attackerId : group.getAttackers()) {
                Permanent creature = game.getPermanent(attackerId);
                if (creature != null && !creature.isControlledBy(attacker)) {
                    violations.add(attack + ": a creature attacked for a player who does not control it");
                }
            }
            if (KingsTableRules.team(from) == KingsTableRules.team(to)) {
                violations.add(attack + ": at a teammate");
            } else if (!allowed.contains(defender)) {
                violations.add(attack + ": at a player the rules do not allow, allowed " + allowed.stream()
                    .map(ids::indexOf).toList());
            }
            if (KingsTableRules.king(from) && !table.rules().kingAttacksAnyone()) {
                int team = KingsTableRules.team(from);
                boolean generalsLive = table.team(team).stream().filter(id -> !id.equals(attacker))
                    .allMatch(id -> game.getPlayer(id).isInGame());
                if (generalsLive) {
                    violations.add(attack + ": a King attacked while both their Generals live");
                }
            }
            // The guard (v0.9.7), counted here by itself: a King never attacks a King whose two
            // Generals are both still in the game.
            if (table.rules().guardedKings() && KingsTableRules.king(from) && KingsTableRules.king(to)
                && table.team(KingsTableRules.team(to)).stream().filter(id -> !id.equals(defender))
                    .allMatch(id -> game.getPlayer(id).isInGame())) {
                violations.add(attack + ": a King attacked a King both of whose Generals live");
            }
        }
    }
}
