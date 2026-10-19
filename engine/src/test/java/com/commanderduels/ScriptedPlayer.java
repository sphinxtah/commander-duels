package com.commanderduels;

import java.util.HashSet;
import java.util.List;
import java.util.Objects;
import java.util.Random;
import java.util.Set;

/**
 * Answers prompts like an eager, slightly random player, so games progress, reach combat and cast
 * commanders. Each choice uses only what the seat was shown.
 */
class ScriptedPlayer {
    private final Random random;
    private int payPromptsInARow;
    boolean customAmounts;

    ScriptedPlayer(long seed) {
        random = new Random(seed);
    }

    String choose(PromptView prompt, SeatView view) {
        List<PromptView.Option> options = prompt.options();
        payPromptsInARow = prompt.kind().equals("pay_mana") ? payPromptsInARow + 1 : 0;
        customAmounts = false;
        int me = view == null ? 0 : view.seat();
        return switch (prompt.kind()) {
            case "priority" -> {
                var lands = byAction(options, "play_land");
                var spells = byAction(options, "cast");
                Set<String> commanders = new HashSet<>();
                if (view != null) {
                    view.you().commanders().stream().map(SeatView.CommanderState::objectId).filter(Objects::nonNull)
                        .forEach(commanders::add);
                }
                var commander = spells.stream().filter(option -> commanders.contains(option.objectId())).toList();
                if (!lands.isEmpty()) {
                    yield pick(lands);
                }
                if (!commander.isEmpty() && random.nextInt(10) < 9) {
                    yield commander.get(0).id();
                }
                if (!spells.isEmpty() && random.nextInt(10) < 8) {
                    yield pick(spells);
                }
                var abilities = byAction(options, "activate");
                if (!abilities.isEmpty() && random.nextInt(10) < 3) {
                    yield pick(abilities);
                }
                yield byAction(options, "pass").get(0).id();
            }
            case "mulligan" -> random.nextInt(10) == 0 ? byAction(options, "mulligan").get(0).id()
                : byAction(options, "keep").get(0).id();
            case "yes_no" -> prompt.message().contains("command zone") && random.nextInt(10) < 8
                ? byAction(options, "yes").get(0).id() : pick(options);
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
            case "choose_defender" -> {
                var players = options.stream().filter(o -> o.seat() != null).toList();
                yield !players.isEmpty() && random.nextInt(10) < 7 ? pick(players) : pick(options);
            }
            case "choose_ability" -> {
                var abilities = byAction(options, "use_ability");
                yield abilities.isEmpty() ? pick(options) : pick(abilities);
            }
            case "choose_choice" -> {
                var choices = byAction(options, "choose");
                yield choices.isEmpty() ? pick(options) : pick(choices);
            }
            case "choose_mode" -> {
                var done = byAction(options, "done");
                var modes = byAction(options, "choose_mode");
                yield !done.isEmpty() && (modes.isEmpty() || random.nextBoolean()) ? done.get(0).id()
                    : modes.isEmpty() ? byAction(options, "cancel").get(0).id() : pick(modes);
            }
            case "choose_amount" -> {
                // A small number: the minimum as the option, or a custom amount just above it.
                PromptView.AmountEntry entry = prompt.amounts().entries().get(0);
                int value = entry.min() + random.nextInt(Math.min(3, entry.max() - entry.min()) + 1);
                yield value == entry.min() ? byAction(options, "suggested").get(0).id() : Tables.AMOUNTS + value;
            }
            case "order_triggers" -> pick(byAction(options, "put_first"));
            case "choose_pile" -> pick(byAction(options, "choose_pile"));
            case "choose_target" -> {
                var done = byAction(options, "done");
                boolean anySelected = options.stream().anyMatch(PromptView.Option::selected);
                var fresh = options.stream().filter(o -> o.action().equals("choose") && !o.selected()).toList();
                var opponents = fresh.stream().filter(o -> o.seat() != null && o.seat() != me).toList();
                if ((anySelected || fresh.isEmpty()) && !done.isEmpty()) {
                    yield done.get(0).id();
                }
                if (!opponents.isEmpty() && random.nextInt(10) < 7) {
                    yield pick(opponents);
                }
                yield fresh.isEmpty() ? pick(options) : pick(fresh);
            }
            default -> throw new IllegalStateException("no policy for " + prompt.kind());
        };
    }

    private String pick(List<PromptView.Option> options) {
        return options.get(random.nextInt(options.size())).id();
    }

    static List<PromptView.Option> byAction(List<PromptView.Option> options, String action) {
        return options.stream().filter(option -> option.action().equals(action)).toList();
    }
}
