package com.commanderduels;

import java.util.List;

/**
 * A typed choice for one seat. Every XMage request becomes a new prompt with a fresh id, and the
 * seat answers with one option id, for assign_amounts and choose_amount optionally with amounts, and
 * for choose_name optionally with a typed name.
 * Kinds: priority, mulligan, yes_no, choose_target, choose_defender (which player, planeswalker or
 * battle an attacker attacks), choose_ability (which of an object's abilities to use, or how to cast
 * a card), choose_choice (one of a list of at most 1,000, such as a colour, a creature type or the
 * order of replacement effects), choose_name (a name from a longer list, such as naming a card: the
 * options are the visible cards' names, and any other name in the list is typed), choose_mode (a
 * modal spell's modes), choose_amount (a number, such as X), order_triggers
 * (which of several simultaneous triggers goes on the stack first), choose_pile, pay_mana,
 * declare_attackers, declare_blockers, assign_amounts, and unsupported (an XMage request this version
 * does not type; the game waits until the seat concedes or the game is closed).
 *
 * @param amounts    the split or number to choose, for assign_amounts and choose_amount only
 * @param piles      the two piles' objects, for choose_pile only; objects the seat may not see are left out
 * @param xmageQuery the XMage query type, for unsupported prompts only
 * @param forSeat    since v0.5.1: the seat whose decision this is when the seat answering controls
 *                   that player's turn (723.5); null for the seat's own decisions. The prompt is
 *                   built from that player's point of view: their cards, their choices
 */
public record PromptView(String id, String kind, String message, String detail, List<Option> options,
                         Amounts amounts, List<List<String>> piles, String xmageQuery, Integer forSeat) {

    /** The same prompt as the decision of another seat, or (with null) as the seat's own. */
    PromptView madeFor(Integer seat) {
        return new PromptView(id, kind, message, detail, options, amounts, piles, xmageQuery, seat);
    }

    /**
     * @param action   what choosing the option does, for example cast, play_land, pass, choose,
     *                 use_ability, choose_mode, put_first, choose_pile or done
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
