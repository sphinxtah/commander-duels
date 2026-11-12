package com.commanderduels;

import java.io.Serializable;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.Collection;
import java.util.HexFormat;
import java.util.List;
import java.util.Random;
import java.util.UUID;
import mage.game.ExileZone;
import mage.game.Game;
import mage.game.GameState;
import mage.game.permanent.Permanent;
import mage.game.stack.StackObject;
import mage.players.Player;

/**
 * A game's whole state at a point it can go on from (v0.9.9): what {@link HumanGame} needs to go on
 * with the game in another process, or in this one after the game's thread is gone.
 *
 * <p>It is taken on the game thread where XMage's state is whole and XMage can later resume: as a
 * player is about to receive priority, and as every player has passed (patch 0018's
 * {@code watchResumable}). The game is XMage's own copy of it, the copy it makes for its saved
 * states and its searches, so the game goes on untouched while the checkpoint is written. With the
 * game: the generator its shuffles and coin flips draw from, as it stood; the ids seats have been
 * shown objects under; the log; each seat's revision and what it was last told; who has conceded;
 * the bots' switch. Each bot's own random source (as it stood: the copy is given its own), budget,
 * habits and statistics are in the game, with the bot.
 *
 * <p>{@link #journalSeq} is where the journal stood: every record up to it is in this state, and
 * the records after it are played on top of it. {@link #stateDigest} is a digest of the state
 * ({@link #digest}), taken with the checkpoint: a checkpoint read back whose game does not have
 * that digest is not the game that was saved, whatever its checksum says, and is not used.
 *
 * @param seats one entry for each human seat, in seat order
 */
record Checkpoint(Game game, Random random, List<UUID> seatIds, ObjectRefs refs, MatchLog.Saved log,
                  List<SeatState> seats, List<Integer> conceded, boolean passiveBots, long spectatorRevision,
                  long version, long journalSeq, int turn, String step, String stateDigest,
                  long eventSeq)
        implements Serializable {

    /** What one human seat's snapshots go on from. */
    record SeatState(int index, long revision, String lastAttacker, List<String> messages, boolean concedeRequested)
            implements Serializable {
        SeatState {
            messages = List.copyOf(messages);
        }
    }

    Checkpoint {
        seatIds = List.copyOf(seatIds);
        seats = List.copyOf(seats);
        conceded = List.copyOf(conceded);
    }

    /**
     * A digest of a game's state, hidden zones included: the turn and where it is, who is active and
     * who has priority, and for each player their life, whether they have passed, their hand, their
     * library in order and their graveyard; every permanent with its controller, whether it is
     * tapped, its damage and its counters; the stack in order; everything in exile; the command zone.
     * Everything is listed in an order of its own (sorted where XMage keeps it unordered), so the
     * digest of a game read back from a checkpoint is the digest it had.
     */
    static String digest(Game game) {
        StringBuilder text = new StringBuilder(8192);
        GameState state = game.getState();
        text.append(game.getTurnNum()).append('|').append(game.getTurnPhaseType()).append('|')
            .append(game.getTurnStepType()).append('|').append(state.getActivePlayerId()).append('|')
            .append(state.getPriorityPlayerId()).append('\n');
        for (Player player : state.getPlayers().values()) {
            text.append("player ").append(player.getId()).append(' ').append(player.getLife()).append(' ')
                .append(player.isPassed()).append(' ').append(player.hasLost()).append(player.hasLeft())
                .append(" hand ").append(sorted(player.getHand()))
                .append(" library ").append(player.getLibrary().getCardList())
                .append(" graveyard ").append(new ArrayList<>(player.getGraveyard())).append('\n');
        }
        List<String> permanents = new ArrayList<>();
        for (Permanent permanent : game.getBattlefield().getAllPermanents()) {
            List<String> counters = new ArrayList<>();
            permanent.getCounters(game).forEach((name, counter) -> counters.add(name + "=" + counter.getCount()));
            counters.sort(null);
            permanents.add(permanent.getId() + " " + permanent.getControllerId() + " " + permanent.isTapped() + " "
                + permanent.getDamage() + " " + counters + " " + sorted(permanent.getAttachments()));
        }
        permanents.sort(null);
        text.append("battlefield ").append(permanents).append('\n').append("stack");
        for (StackObject object : game.getStack()) {
            text.append(' ').append(object.getId()).append('/').append(object.getControllerId());
        }
        List<String> exiled = new ArrayList<>();
        for (ExileZone zone : game.getExile().getExileZones()) {
            for (UUID card : zone) {
                exiled.add(zone.getId() + ":" + card);
            }
        }
        exiled.sort(null);
        text.append("\nexile ").append(exiled).append("\ncommand");
        List<String> command = new ArrayList<>();
        state.getCommand().forEach(object -> command.add(object.getId().toString()));
        command.sort(null);
        text.append(command);
        try {
            byte[] hash = MessageDigest.getInstance("SHA-256").digest(text.toString().getBytes(StandardCharsets.UTF_8));
            return HexFormat.of().formatHex(hash, 0, 16);
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    private static List<String> sorted(Collection<UUID> ids) {
        List<String> sorted = new ArrayList<>();
        ids.forEach(id -> sorted.add(id.toString()));
        sorted.sort(null);
        return sorted;
    }
}
