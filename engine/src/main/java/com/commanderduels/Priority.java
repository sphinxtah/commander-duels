package com.commanderduels;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.function.BiConsumer;
import java.util.function.Function;
import mage.constants.PlayerAction;
import mage.game.Game;
import mage.players.Player;
import mage.players.PlayerImpl;
import mage.players.net.SkipPrioritySteps;
import mage.players.net.UserData;
import mage.players.net.UserSkipPrioritySteps;

/**
 * Priority controls (UI07), on XMage's own human player: the modes are XMage's, so its rules for
 * when a pass ends are the engine's rules too.
 *
 * <p>Passing: a priority prompt offers "pass until" options beside a plain pass. Choosing one
 * sends XMage the matching player action, which passes now and keeps passing until its end: the
 * end of the turn, the next turn, your next turn, the next main phase, the end step before your
 * next turn, or (with something on the stack) until the stack resolves. XMage ends every such pass
 * early when an object is put on the stack, if the seat stops for new stack objects, and at the
 * declare attackers and blockers steps the seat stops at. Cancel ends a pass at once.
 *
 * <p>Stops: with an empty stack, XMage gives the seat priority only in the steps it stops at,
 * chosen for its own turn and for the others' (XMage's default: both main phases). Full control
 * stops at every step, at every new stack object and at every combat declaration, and keeps
 * priority after the seat casts or activates; turning it off returns to the defaults. Holding
 * priority after a cast is the default; "pass after casting" passes instead.
 *
 * <p>No timer decides anything: XMage waits for the seat's answer however long it takes, so no
 * animation can stand in for a response window.
 */
final class Priority {
    /** Pass modes, in the order prompts offer them: option action, XMage action, label. */
    record Mode(String action, PlayerAction xmage, String label, String passing) {}

    static final List<Mode> MODES = List.of(
        new Mode("pass_until_stack_resolved", PlayerAction.PASS_PRIORITY_UNTIL_STACK_RESOLVED,
            "Pass until the stack resolves", "until_stack_resolved"),
        new Mode("pass_until_next_main", PlayerAction.PASS_PRIORITY_UNTIL_NEXT_MAIN_PHASE,
            "Pass until the next main phase", "until_next_main"),
        new Mode("pass_until_end_of_turn", PlayerAction.PASS_PRIORITY_UNTIL_TURN_END_STEP,
            "Pass until the end of the turn", "until_end_of_turn"),
        new Mode("pass_until_next_turn", PlayerAction.PASS_PRIORITY_UNTIL_NEXT_TURN,
            "Pass until the next turn", "until_next_turn"),
        new Mode("pass_until_end_step_before_my_turn", PlayerAction.PASS_PRIORITY_UNTIL_END_STEP_BEFORE_MY_NEXT_TURN,
            "Pass until the end step before your turn", "until_end_step_before_my_turn"),
        new Mode("pass_until_my_turn", PlayerAction.PASS_PRIORITY_UNTIL_MY_NEXT_TURN,
            "Pass until your next turn", "until_my_turn"));

    /** The steps a seat may stop at, by name, with XMage's getter and setter for each. */
    private static final Map<String, Step> STEPS = new LinkedHashMap<>();

    private record Step(Function<SkipPrioritySteps, Boolean> get, BiConsumer<SkipPrioritySteps, Boolean> set) {}

    static {
        STEPS.put("upkeep", new Step(SkipPrioritySteps::isUpkeep, SkipPrioritySteps::setUpkeep));
        STEPS.put("draw", new Step(SkipPrioritySteps::isDraw, SkipPrioritySteps::setDraw));
        STEPS.put("main1", new Step(SkipPrioritySteps::isMain1, SkipPrioritySteps::setMain1));
        STEPS.put("before_combat", new Step(SkipPrioritySteps::isBeforeCombat, SkipPrioritySteps::setBeforeCombat));
        STEPS.put("end_of_combat", new Step(SkipPrioritySteps::isEndOfCombat, SkipPrioritySteps::setEndOfCombat));
        STEPS.put("main2", new Step(SkipPrioritySteps::isMain2, SkipPrioritySteps::setMain2));
        STEPS.put("end_of_turn", new Step(SkipPrioritySteps::isEndOfTurn, SkipPrioritySteps::setEndOfTurn));
    }

    static final Set<String> SETTINGS = Set.of("your_turn", "opponent_turn", "stop_on_new_stack_objects",
        "stop_on_attackers", "stop_on_blockers", "pass_after_casting", "full_control", "cancel_passes");

    /**
     * A change to the controls; null fields stay as they are.
     *
     * @param yourTurn     the steps to stop at in the seat's own turns
     * @param opponentTurn the steps to stop at in the other players' turns
     */
    record Settings(List<String> yourTurn, List<String> opponentTurn, Boolean stopOnNewStackObjects,
                    Boolean stopOnAttackers, Boolean stopOnBlockers, Boolean passAfterCasting, Boolean fullControl,
                    boolean cancelPasses) {
        String fingerprint() {
            return String.join("|", String.valueOf(yourTurn), String.valueOf(opponentTurn),
                String.valueOf(stopOnNewStackObjects), String.valueOf(stopOnAttackers), String.valueOf(stopOnBlockers),
                String.valueOf(passAfterCasting), String.valueOf(fullControl), String.valueOf(cancelPasses));
        }
    }

    private Priority() {}

    static Settings parse(JsonObject payload) throws JsonRequest.Invalid {
        JsonRequest.onlyFields(payload, SETTINGS, "payload.");
        if (payload.isEmpty()) {
            throw new JsonRequest.Invalid("set_priority needs at least one setting");
        }
        return new Settings(steps(payload, "your_turn"), steps(payload, "opponent_turn"),
            flag(payload, "stop_on_new_stack_objects"), flag(payload, "stop_on_attackers"),
            flag(payload, "stop_on_blockers"), flag(payload, "pass_after_casting"), flag(payload, "full_control"),
            Boolean.TRUE.equals(flag(payload, "cancel_passes")));
    }

    private static Boolean flag(JsonObject payload, String name) throws JsonRequest.Invalid {
        if (!payload.has(name)) {
            return null;
        }
        JsonElement value = payload.get(name);
        if (!value.isJsonPrimitive() || !value.getAsJsonPrimitive().isBoolean()) {
            throw new JsonRequest.Invalid("payload." + name + " must be true or false");
        }
        return value.getAsBoolean();
    }

    private static List<String> steps(JsonObject payload, String name) throws JsonRequest.Invalid {
        if (!payload.has(name)) {
            return null;
        }
        JsonElement value = payload.get(name);
        if (!value.isJsonArray() || value.getAsJsonArray().size() > STEPS.size()) {
            throw new JsonRequest.Invalid("payload." + name + " must list steps from " + STEPS.keySet());
        }
        List<String> chosen = new ArrayList<>();
        for (JsonElement item : value.getAsJsonArray()) {
            String step = item.isJsonPrimitive() ? item.getAsString().toLowerCase(Locale.ROOT) : "";
            if (!STEPS.containsKey(step)) {
                throw new JsonRequest.Invalid("payload." + name + " must list steps from " + STEPS.keySet());
            }
            if (!chosen.contains(step)) {
                chosen.add(step);
            }
        }
        return List.copyOf(chosen);
    }

    /** Request thread: applies the change to the player's settings. XMage reads them as it plays. */
    static void apply(Player player, Game game, Settings settings) {
        UserData data = player.getUserData();
        UserSkipPrioritySteps stops = data.getUserSkipPrioritySteps();
        if (Boolean.TRUE.equals(settings.fullControl())) {
            STEPS.values().forEach(step -> {
                step.set().accept(stops.getYourTurn(), true);
                step.set().accept(stops.getOpponentTurn(), true);
            });
            stops.setStopOnStackNewObjects(true);
            stops.setStopOnDeclareAttackersDuringSkipActions(true);
            stops.setStopOnDeclareBlockersWithAnyPermanents(true);
            stops.setStopOnDeclareBlockersWithZeroPermanents(true);
            data.setPassPriorityCast(false);
            data.setPassPriorityActivation(false);
        } else if (Boolean.FALSE.equals(settings.fullControl())) {
            UserData defaults = UserData.getDefaultUserDataView();
            UserSkipPrioritySteps standard = defaults.getUserSkipPrioritySteps();
            STEPS.values().forEach(step -> {
                step.set().accept(stops.getYourTurn(), step.get().apply(standard.getYourTurn()));
                step.set().accept(stops.getOpponentTurn(), step.get().apply(standard.getOpponentTurn()));
            });
            stops.setStopOnStackNewObjects(standard.isStopOnStackNewObjects());
            stops.setStopOnDeclareAttackersDuringSkipActions(standard.isStopOnDeclareAttackers());
            stops.setStopOnDeclareBlockersWithAnyPermanents(standard.isStopOnDeclareBlockersWithAnyPermanents());
            stops.setStopOnDeclareBlockersWithZeroPermanents(standard.isStopOnDeclareBlockersWithZeroPermanents());
            data.setPassPriorityCast(defaults.isPassPriorityCast());
            data.setPassPriorityActivation(defaults.isPassPriorityActivation());
        }
        if (settings.yourTurn() != null) {
            STEPS.forEach((name, step) -> step.set().accept(stops.getYourTurn(), settings.yourTurn().contains(name)));
        }
        if (settings.opponentTurn() != null) {
            STEPS.forEach((name, step) ->
                step.set().accept(stops.getOpponentTurn(), settings.opponentTurn().contains(name)));
        }
        if (settings.stopOnNewStackObjects() != null) {
            stops.setStopOnStackNewObjects(settings.stopOnNewStackObjects());
        }
        if (settings.stopOnAttackers() != null) {
            stops.setStopOnDeclareAttackersDuringSkipActions(settings.stopOnAttackers());
        }
        if (settings.stopOnBlockers() != null) {
            stops.setStopOnDeclareBlockersWithAnyPermanents(settings.stopOnBlockers());
            stops.setStopOnDeclareBlockersWithZeroPermanents(settings.stopOnBlockers()
                && stops.isStopOnDeclareBlockersWithZeroPermanents());
        }
        if (settings.passAfterCasting() != null) {
            data.setPassPriorityCast(settings.passAfterCasting());
            data.setPassPriorityActivation(settings.passAfterCasting());
        }
        if (settings.cancelPasses()) {
            player.sendPlayerAction(PlayerAction.PASS_PRIORITY_CANCEL_ALL_ACTIONS, game, null);
        }
    }

    /** The seat's controls as its view shows them. */
    static SeatView.PriorityControls controls(Player player) {
        String passing = null;
        if (player instanceof PlayerImpl impl) {
            if (impl.getPassedUntilStackResolved()) {
                passing = "until_stack_resolved";
            } else if (impl.getPassedUntilNextMain()) {
                passing = "until_next_main";
            } else if (impl.getPassedUntilEndOfTurn()) {
                passing = "until_end_of_turn";
            } else if (impl.getPassedTurn()) {
                passing = "until_next_turn";
            } else if (impl.getPassedUntilEndStepBeforeMyTurn()) {
                passing = "until_end_step_before_my_turn";
            } else if (impl.getPassedAllTurns()) {
                passing = "until_my_turn";
            }
        }
        UserData data = player.getUserData();
        UserSkipPrioritySteps stops = data.getUserSkipPrioritySteps();
        List<String> yours = new ArrayList<>();
        List<String> theirs = new ArrayList<>();
        STEPS.forEach((name, step) -> {
            if (step.get().apply(stops.getYourTurn())) {
                yours.add(name);
            }
            if (step.get().apply(stops.getOpponentTurn())) {
                theirs.add(name);
            }
        });
        boolean full = yours.size() == STEPS.size() && theirs.size() == STEPS.size()
            && stops.isStopOnStackNewObjects() && stops.isStopOnDeclareAttackers()
            && stops.isStopOnDeclareBlockersWithAnyPermanents() && !data.isPassPriorityCast();
        return new SeatView.PriorityControls(passing, List.copyOf(yours), List.copyOf(theirs),
            stops.isStopOnStackNewObjects(), stops.isStopOnDeclareAttackers(),
            stops.isStopOnDeclareBlockersWithAnyPermanents(), data.isPassPriorityCast(), full);
    }
}
