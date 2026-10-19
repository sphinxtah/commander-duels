package com.commanderduels;

import java.util.List;

/**
 * A typed choice for one seat. Every XMage request becomes a new prompt with a fresh id, and the
 * seat answers with one option id, or for assign_amounts optionally with a list of amounts. Kinds:
 * priority, mulligan, yes_no, choose_target, pay_mana, declare_attackers, declare_blockers,
 * assign_amounts, and unsupported (an XMage request this version does not type; the game waits until
 * the seat concedes or the game is closed).
 *
 * @param amounts    the split to choose, for assign_amounts only
 * @param xmageQuery the XMage query type, for unsupported prompts only
 */
public record PromptView(String id, String kind, String message, String detail, List<Option> options,
                         Amounts amounts, String xmageQuery) {

    /**
     * @param action   what choosing the option does, for example cast, play_land, pass, choose or done
     * @param objectId an opaque object id from the seat's view, when the option is an object
     * @param seat     the player's seat, when the option is a player
     * @param selected whether the object is already chosen (choosing it again removes it)
     */
    public record Option(String id, String action, String label, String objectId, Integer seat,
                         boolean selected) {}

    /** One amount per entry, each within its limits, adding up to between totalMin and totalMax. */
    public record Amounts(int totalMin, int totalMax, List<AmountEntry> entries) {
        boolean accepts(List<Integer> values) {
            if (values.size() != entries.size()) {
                return false;
            }
            long sum = 0;
            for (int i = 0; i < values.size(); i++) {
                int value = values.get(i);
                if (value < entries.get(i).min() || value > entries.get(i).max()) {
                    return false;
                }
                sum += value;
            }
            return sum >= totalMin && sum <= totalMax;
        }
    }

    /** {@code suggested} is XMage's default, which the "suggested" option submits. */
    public record AmountEntry(String label, int min, int max, int suggested) {}
}
