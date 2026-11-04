package com.commanderduels;

/**
 * A human player whose answer may wait until XMage listens for it (v0.8.7): XMage's own
 * {@code HumanPlayer.waitResponseOpen}, which its other answers already use, for the pass that
 * does not ({@link Prompts.PassAnswer}).
 */
interface OpensResponse {
    /** Waits until XMage's game thread listens for this player's answer; false if it never did. */
    boolean awaitResponseOpen();
}
