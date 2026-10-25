package com.commanderduels;

import java.io.Serializable;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Comparator;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;
import java.util.UUID;
import mage.Mana;
import mage.MageObject;
import mage.abilities.Abilities;
import mage.abilities.Ability;
import mage.abilities.Modes;
import mage.abilities.ActivatedAbility;
import mage.abilities.PlayLandAbility;
import mage.abilities.SpellAbility;
import mage.abilities.costs.mana.ManaCost;
import mage.abilities.costs.mana.ManaCostsImpl;
import mage.abilities.mana.ActivatedManaAbilityImpl;
import mage.cards.Card;
import mage.choices.Choice;
import mage.constants.AsThoughEffectType;
import mage.constants.Constants;
import mage.constants.ManaType;
import mage.constants.PlayerAction;
import mage.constants.MultiAmountType;
import mage.constants.Zone;
import mage.game.Game;
import mage.game.combat.CombatGroup;
import mage.game.events.PlayerQueryEvent;
import mage.game.permanent.Permanent;
import mage.players.ManaPool;
import mage.players.Player;
import mage.players.PlayerImpl;
import mage.target.common.TargetAttackingCreature;
import mage.util.MultiAmountMessage;

/**
 * Turns XMage's {@link PlayerQueryEvent}s for a human seat into typed prompts. Each option maps to
 * the answer XMage's {@code HumanPlayer} expects (a UUID, boolean or string), so the seat never
 * sends XMage identifiers itself. XMage validates the answer again and asks again if it rejects it.
 * Runs on the game thread, while XMage is about to wait for the answer. Since v0.5.1 the player
 * asked may be one whose turn the seat controls (723): the prompt is then that player's, built from
 * what they may see, and the answer goes to them.
 */
final class Prompts {
    private static final String LEFT_BUTTON = "UI.left.btn.text";
    private static final String RIGHT_BUTTON = "UI.right.btn.text";
    /** XMage's message for its TargetDefender, which HumanPlayer uses when there is more than one defender. */
    static final String DEFENDER_MESSAGE = "Select a player, planeswalker, or battle to attack";
    /**
     * Choices up to this long are offered as options: a creature type, for instance, is one of about
     * 300. Longer ones (naming a card, one of tens of thousands) become choose_name, a name the seat
     * types, checked against the list.
     */
    static final int MAX_CHOICE_OPTIONS = 1_000;
    /** A choose_name prompt offers the names of at most this many cards the seat can see. */
    static final int MAX_NAME_SUGGESTIONS = 12;
    /** A refusal of a typed name suggests at most this many names that start like it. */
    static final int MAX_NEAR_NAMES = 5;

    /**
     * An open prompt: what the seat sees and the XMage answer behind each option id.
     *
     * @param names for choose_name only: every name the choice accepts, keyed by {@link #fold}
     */
    record Prompt(PromptView view, Map<String, Answer> answers, Map<String, String> names) {
        boolean supported() {
            return !view.kind().equals("unsupported");
        }

        /** The answer for a typed name, or null when this prompt takes none or the list lacks it. */
        Answer name(String text) {
            String found = names == null ? null : names.get(fold(text));
            return found == null ? null : new StringAnswer(found);
        }

        /**
         * Names in the list that start like the text, alphabetically, for a refusal to suggest;
         * never a hidden card's name ({@link HiddenCards}), which a refusal would otherwise reveal.
         */
        List<String> near(String text) {
            if (names == null) {
                return List.of();
            }
            String start = fold(text);
            return names.entrySet().stream().filter(entry -> entry.getKey().startsWith(start))
                .map(Map.Entry::getValue).filter(name -> !HiddenCards.hidden(name)).sorted()
                .limit(MAX_NEAR_NAMES).toList();
        }

        /**
         * The answer for a custom split or number, or null when this prompt takes none or the amounts
         * break a limit.
         */
        Answer amounts(List<Integer> values) {
            if (view.amounts() == null || !view.amounts().accepts(values)) {
                return null;
            }
            return view.kind().equals("choose_amount") ? new IntegerAnswer(values.get(0))
                : new StringAnswer(encode(values));
        }

        /**
         * The answer that does the least, for a decision nobody is left to make (v0.5.1: the seat
         * answering for a player whose turn it controlled left the game while XMage waited): pass,
         * keep, no, done, cancel, the suggestion, or else the first choice. Null for an unsupported
         * request.
         */
        Answer fallback() {
            List<String> order = switch (view.kind()) {
                case "priority" -> List.of("pass");
                case "mulligan" -> List.of("keep");
                case "yes_no" -> List.of("no");
                case "declare_attackers", "declare_blockers" -> List.of("done");
                case "assign_amounts", "choose_amount" -> List.of("suggested");
                default -> List.of("done", "cancel", "suggested");
            };
            for (String action : order) {
                for (PromptView.Option option : view.options()) {
                    if (option.action().equals(action)) {
                        return answers.get(option.id());
                    }
                }
            }
            return view.options().stream().filter(option -> !option.selected()).findFirst()
                .or(() -> view.options().stream().findFirst()).map(option -> answers.get(option.id())).orElse(null);
        }
    }

    /** One way to answer XMage's waiting {@code HumanPlayer}. Called from a request thread. */
    sealed interface Answer {
        void apply(Player player);
    }

    record UuidAnswer(UUID id) implements Answer {
        @Override
        public void apply(Player player) {
            player.setResponseUUID(id);
        }
    }

    /** A pass mode: XMage passes now and keeps passing until the mode ends (see {@link Priority}). */
    record PassAnswer(PlayerAction action, Game game) implements Answer {
        @Override
        public void apply(Player player) {
            player.sendPlayerAction(action, game, null);
        }
    }

    record BooleanAnswer(boolean value) implements Answer {
        @Override
        public void apply(Player player) {
            player.setResponseBoolean(value);
        }
    }

    record StringAnswer(String value) implements Answer {
        @Override
        public void apply(Player player) {
            player.setResponseString(value);
        }
    }

    record IntegerAnswer(int value) implements Answer {
        @Override
        public void apply(Player player) {
            player.setResponseInteger(value);
        }
    }

    record ManaAnswer(UUID poolOwner, ManaType type) implements Answer {
        @Override
        public void apply(Player player) {
            player.setResponseManaType(poolOwner, type);
        }
    }

    private final Game game;
    /** The player whose decision it is: the seat's own, or one whose turn the seat controls. */
    private final Player player;
    private final SeatViews views;
    /** The decision is made for a player whose turn the answering seat controls (723.5). */
    private final boolean controlled;
    private final List<PromptView.Option> options = new ArrayList<>();
    private final Map<String, Answer> answers = new LinkedHashMap<>();

    private Prompts(Game game, Player player, SeatViews views, boolean controlled) {
        this.game = game;
        this.player = player;
        this.views = views;
        this.controlled = controlled;
    }

    /**
     * @param player   the player XMage asks: the seat's own, or (since v0.5.1) a player whose turn
     *                 the seat controls, from whose point of view the prompt is built (723.4)
     * @param attacker the attacker the seat last toggled, which a defender choice is about; XMage's
     *                 request does not name it
     * @param forSeat  the asked player's seat when another seat answers for them, else null
     */
    static Prompt build(PlayerQueryEvent event, Game game, Player player, SeatViews views, String promptId,
                        String attacker, Integer forSeat) {
        Prompt prompt = new Prompts(game, player, views, forSeat != null).from(event, promptId);
        if (prompt.view().kind().equals("choose_defender") && prompt.view().detail() == null && attacker != null) {
            PromptView view = prompt.view();
            prompt = new Prompt(new PromptView(view.id(), view.kind(), view.message(), "Attacker: " + attacker,
                view.options(), view.amounts(), view.piles(), view.xmageQuery(), null, null), prompt.answers(),
                prompt.names());
        }
        if (forSeat != null) {
            // XMage adds " (as <player>)" to a controlled player's requests; the prompt says whose
            // decision it is in its own field, by seat, and the engine's player names are not the
            // table's.
            PromptView view = prompt.view();
            String hint = " (as " + SeatViews.plain(player.getLogName()) + ")";
            prompt = new Prompt(new PromptView(view.id(), view.kind(), view.message().replace(hint, ""),
                view.detail() == null ? null : view.detail().replace(hint, ""), view.options(), view.amounts(),
                view.piles(), view.xmageQuery(), forSeat, null), prompt.answers(), prompt.names());
        }
        PromptView.Team team = team(game, player, prompt.view().kind());
        if (team != null) {
            PromptView view = prompt.view();
            prompt = new Prompt(new PromptView(view.id(), view.kind(), view.message(), view.detail(), view.options(),
                view.amounts(), view.piles(), view.xmageQuery(), view.forSeat(), team), prompt.answers(),
                prompt.names());
        }
        return prompt;
    }

    /**
     * The asked player's part in their team's decision (since v0.6.1), null without a teammate.
     * 805.5: the team has priority, and passes once each of its players has passed in succession;
     * a priority prompt says whether the asked player's teammates still in the game have all passed
     * since the team last acted (XMage's pass flags, which any action clears).
     */
    static PromptView.Team team(Game game, Player player, String kind) {
        var teammates = game.getTeammates(player.getId());
        if (teammates.isEmpty()) {
            return null;
        }
        Boolean passed = null;
        if (kind.equals("priority")) {
            passed = teammates.stream().map(game::getPlayer)
                .allMatch(teammate -> teammate == null || teammate.isPassed() || !teammate.canRespond());
        }
        return new PromptView.Team(passed);
    }

    private Prompt from(PlayerQueryEvent event, String promptId) {
        Map<String, Serializable> extra = event.getOptions() == null ? Map.of() : event.getOptions();
        String message = SeatViews.plain(event.getMessage());
        PromptView.Amounts amounts = null;
        List<List<String>> piles = null;
        Map<String, String> names = null;
        String detail = extra.get(Constants.Option.SECOND_MESSAGE) instanceof String second
            && !SeatViews.plain(second).isEmpty() ? SeatViews.plain(second) : null;
        String kind;
        switch (event.getQueryType()) {
            case SELECT:
                if (extra.containsKey(Constants.Option.POSSIBLE_ATTACKERS)) {
                    kind = "declare_attackers";
                    combatants(uuids(extra.get(Constants.Option.POSSIBLE_ATTACKERS)),
                        game.getCombat().getAttackers(), "toggle_attacker");
                    if (extra.containsKey(Constants.Option.SPECIAL_BUTTON)) {
                        add("all_attack", "All attack", null, null, false, new StringAnswer("special"));
                    }
                    add("done", "Done", null, null, false, new BooleanAnswer(true));
                } else if (extra.containsKey(Constants.Option.POSSIBLE_BLOCKERS)) {
                    kind = "declare_blockers";
                    combatants(canBlockAny(uuids(extra.get(Constants.Option.POSSIBLE_BLOCKERS))),
                        game.getCombat().getBlockers(), "toggle_blocker");
                    add("done", "Done", null, null, false, new BooleanAnswer(true));
                } else {
                    kind = "priority";
                    priority();
                }
                break;
            case ASK:
                ask(extra);
                kind = "Mulligan".equals(extra.get(LEFT_BUTTON)) && "Keep".equals(extra.get(RIGHT_BUTTON))
                    ? "mulligan" : "yes_no";
                break;
            case PICK_TARGET:
                kind = message.startsWith(DEFENDER_MESSAGE) ? "choose_defender" : "choose_target";
                target(event, extra);
                break;
            case CHOOSE_ABILITY:
                kind = "choose_ability";
                ability(event);
                break;
            case CHOOSE_MODE:
                kind = "choose_mode";
                modes(event);
                break;
            case AMOUNT:
                kind = "choose_amount";
                amounts = number(event, message);
                break;
            case PICK_ABILITY:
                kind = "order_triggers";
                triggers(event);
                break;
            case CHOOSE_PILE:
                kind = "choose_pile";
                piles = piles(event);
                break;
            case CHOOSE_CHOICE: {
                Choice choice = event.getChoice();
                if (choice == null) {
                    return unsupported(event, promptId, message, detail);
                }
                if (choice(choice)) {
                    kind = "choose_choice";
                } else if (!choice.isKeyChoice() && choice.getChoices().size() > MAX_CHOICE_OPTIONS) {
                    kind = "choose_name";
                    names = names(choice);
                } else {
                    return unsupported(event, promptId, message, detail);
                }
                message = SeatViews.plain(choice.getMessage());
                String sub = SeatViews.plain(choice.getSubMessage());
                detail = sub.isEmpty() ? null : sub;
                break;
            }
            case PLAY_MANA: {
                kind = "pay_mana";
                ManaCost unpaid = spendsAsOtherTypes() ? null : unpaidCost(event.getMessage());
                payMana(unpaid);
                // Cancel alone: say why, so the seat does not look stuck (UI04).
                if (detail == null && options.size() == 1) {
                    detail = "Nothing you control can pay " + (unpaid == null ? "this cost" : unpaid.getText()) + ".";
                }
                break;
            }
            case MULTI_AMOUNT:
                kind = "assign_amounts";
                if (message.isEmpty()) {
                    message = extra.get("header") instanceof String header ? SeatViews.plain(header) : "";
                }
                if (detail == null && extra.get("title") instanceof String title && !SeatViews.plain(title).isEmpty()) {
                    detail = SeatViews.plain(title);
                }
                amounts = amounts(event, extra);
                break;
            default:
                return unsupported(event, promptId, message, detail);
        }
        return new Prompt(new PromptView(promptId, kind, message, detail, List.copyOf(options), amounts, piles,
            null, null, null), Map.copyOf(answers), names);
    }

    private Prompt unsupported(PlayerQueryEvent event, String promptId, String message, String detail) {
        options.clear();
        answers.clear();
        return new Prompt(new PromptView(promptId, "unsupported", message, detail, List.of(), null, null,
            event.getQueryType().name(), null, null), Map.of(), null);
    }

    /** A name as the seat may type it: case, surrounding spaces and curly apostrophes do not matter. */
    static String fold(String name) {
        return name.strip().replace('’', '\'').toLowerCase(Locale.ROOT);
    }

    /**
     * A modal spell's or ability's modes, plus XMage's done and cancel entries. Mode ids are XMage's
     * and stay on the server; XMage asks again for each further mode.
     */
    private void modes(PlayerQueryEvent event) {
        Map<UUID, String> modes = event.getModes() == null ? Map.of() : event.getModes();
        for (Map.Entry<UUID, String> mode : modes.entrySet()) {
            UUID id = mode.getKey();
            String action = Modes.CHOOSE_OPTION_DONE_ID.equals(id) ? "done"
                : Modes.CHOOSE_OPTION_CANCEL_ID.equals(id) ? "cancel" : "choose_mode";
            add(action, SeatViews.plain(mode.getValue()), null, null, false, new UuidAnswer(id));
        }
    }

    /** A number from min to max (an X value, for instance): the minimum as an option, or any amount. */
    private PromptView.Amounts number(PlayerQueryEvent event, String message) {
        int min = event.getMin();
        int max = Math.max(min, event.getMax());
        add("suggested", "Choose " + min, null, null, false, new IntegerAnswer(min));
        return new PromptView.Amounts(min, max, List.of(new PromptView.AmountEntry(message, min, max, min)));
    }

    /**
     * Several of the seat's triggers at once: the one chosen goes on the stack first, and XMage asks
     * again. In a team game they are the team's (805.7, since v0.6.1): each option names its
     * controller's seat.
     */
    private void triggers(PlayerQueryEvent event) {
        List<? extends Ability> abilities = event.getAbilities() == null ? List.of() : event.getAbilities();
        boolean team = !game.getTeammates(player.getId()).isEmpty();
        for (Ability ability : abilities) {
            MageObject source = game.getObject(ability.getSourceId());
            boolean visible = Visibility.identityVisible(game, ability.getSourceId(), player.getId());
            String rule = SeatViews.plain(ability.getRule(source == null ? null : source.getName()));
            add("put_first", rule.isEmpty() ? ability.toString() : rule,
                visible ? views.objectRef(ability.getSourceId()) : null,
                team ? Integer.valueOf(views.seatOf(ability.getControllerId())) : null, false,
                new UuidAnswer(ability.getId()));
        }
    }

    /** Two piles of cards (Fact or Fiction, for instance): XMage takes true for the first pile. */
    private List<List<String>> piles(PlayerQueryEvent event) {
        List<List<String>> piles = new ArrayList<>();
        List<List<? extends Card>> sources = new ArrayList<>();
        sources.add(event.getPile1() == null ? List.of() : event.getPile1());
        sources.add(event.getPile2() == null ? List.of() : event.getPile2());
        for (int pile = 0; pile < 2; pile++) {
            List<String> ids = new ArrayList<>();
            List<String> names = new ArrayList<>();
            for (Card card : sources.get(pile)) {
                if (Visibility.identityVisible(game, card.getId(), player.getId())) {
                    ids.add(views.ref(card));
                    names.add(card.getName());
                }
            }
            int hidden = sources.get(pile).size() - ids.size();
            String label = "Pile " + (pile + 1) + ": " + (names.isEmpty() ? "no visible cards" : String.join(", ", names))
                + (hidden > 0 ? " and " + hidden + " hidden" : "");
            add("choose_pile", label, null, null, false, new BooleanAnswer(pile == 0));
            piles.add(List.copyOf(ids));
        }
        return List.copyOf(piles);
    }

    /** Which of an object's abilities to use, or how to cast a card with more than one way to cast it. */
    private void ability(PlayerQueryEvent event) {
        String source = event.getChoices() == null || event.getChoices().isEmpty() ? null
            : event.getChoices().iterator().next();
        List<? extends Ability> abilities = event.getAbilities() == null ? List.of() : event.getAbilities();
        for (Ability ability : abilities) {
            String rule = SeatViews.plain(source == null ? ability.getRule() : ability.getRule(source));
            add("use_ability", rule.isEmpty() ? ability.toString() : rule, null, null, false,
                new UuidAnswer(ability.getId()));
        }
        add("cancel", "Cancel", null, null, false, new BooleanAnswer(false));
    }

    /**
     * One of a fixed list of choices: a colour, a creature type, or which replacement effect applies first. A key
     * choice answers with its key (for replacement effects, an XMage id that stays on the server),
     * any other with the text. Returns false when the list is too long to offer.
     */
    private boolean choice(Choice choice) {
        List<String[]> entries = new ArrayList<>();
        if (choice.isKeyChoice()) {
            Map<String, Integer> order = choice.getSortData() == null ? Map.of() : choice.getSortData();
            List<Map.Entry<String, String>> keyed = new ArrayList<>(choice.getKeyChoices().entrySet());
            keyed.sort(Comparator.comparing((Map.Entry<String, String> entry) -> order.getOrDefault(entry.getKey(),
                Integer.MAX_VALUE)));
            keyed.forEach(entry -> entries.add(new String[]{entry.getKey(), entry.getValue()}));
        } else {
            choice.getChoices().stream().sorted().forEach(value -> entries.add(new String[]{value, value}));
        }
        if (entries.isEmpty() || entries.size() > MAX_CHOICE_OPTIONS) {
            return false;
        }
        for (String[] entry : entries) {
            add("choose", SeatViews.plain(entry[1]), null, null, false, new StringAnswer(entry[0]));
        }
        if (!choice.isRequired()) {
            // HumanPlayer treats an empty answer to an optional choice as cancelling it.
            add("cancel", "Cancel", null, null, false, new StringAnswer(""));
        }
        return true;
    }

    /**
     * A choice too long to list, such as naming a card: the seat types any name the choice accepts.
     * The names of cards the seat can see that the choice accepts are offered as options, so the
     * usual answers are one press away; the list names no card the seat cannot see.
     */
    private Map<String, String> names(Choice choice) {
        Set<String> accepted = choice.getChoices();
        Map<String, String> folded = new HashMap<>();
        for (String name : accepted) {
            folded.putIfAbsent(fold(name), name);
        }
        Set<String> seen = new TreeSet<>();
        for (Card card : game.getCards()) {
            if (accepted.contains(card.getName()) && Visibility.identityVisible(game, card.getId(), player.getId())) {
                seen.add(card.getName());
            }
        }
        seen.stream().limit(MAX_NAME_SUGGESTIONS)
            .forEach(name -> add("choose", name, null, null, false, new StringAnswer(name)));
        if (!choice.isRequired()) {
            add("cancel", "Cancel", null, null, false, new StringAnswer(""));
        }
        return Map.copyOf(folded);
    }

    private void priority() {
        add("pass", "Pass priority", null, null, false, new BooleanAnswer(true));
        // A controlled player is asked at every priority (XMage skips nothing for a player whose turn
        // another controls), and a pass mode would stay with that player after the control ends, so
        // the seat answering for them passes once at a time.
        for (Priority.Mode mode : controlled ? List.<Priority.Mode>of() : Priority.MODES) {
            if (mode.xmage() != PlayerAction.PASS_PRIORITY_UNTIL_STACK_RESOLVED || !game.getStack().isEmpty()) {
                add(mode.action(), mode.label(), null, null, false, new PassAnswer(mode.xmage(), game));
            }
        }
        Map<UUID, List<ActivatedAbility>> byObject = new LinkedHashMap<>();
        // Every seat's player, human or bot, is one of XMage's PlayerImpl.
        for (ActivatedAbility ability : ((PlayerImpl) player).getPlayable(game, true, Zone.ALL, false)) {
            byObject.computeIfAbsent(clickTarget(ability.getSourceId()), id -> new ArrayList<>()).add(ability);
        }
        List<UUID> objects = new ArrayList<>(byObject.keySet());
        objects.sort(Comparator.comparingInt(this::zoneRank).thenComparing(this::label,
            Comparator.nullsLast(Comparator.naturalOrder())).thenComparing(views::objectRef));
        for (UUID id : objects) {
            add(action(byObject.get(id)), label(id), views.objectRef(id), null, false, new UuidAnswer(id));
        }
    }

    /** The object XMage expects a click on: the main card of a card part, or the spell on the stack. */
    private UUID clickTarget(UUID sourceId) {
        Card card = game.getCard(sourceId);
        if (card != null && game.getSpell(sourceId) == null) {
            return card.getMainCard().getId();
        }
        return sourceId;
    }

    private static String action(List<ActivatedAbility> abilities) {
        if (abilities.stream().anyMatch(PlayLandAbility.class::isInstance)) {
            return "play_land";
        }
        if (abilities.stream().anyMatch(SpellAbility.class::isInstance)) {
            return "cast";
        }
        if (abilities.stream().allMatch(ActivatedAbility::isManaActivatedAbility)) {
            return "activate_mana";
        }
        return "activate";
    }

    private void ask(Map<String, Serializable> extra) {
        boolean mulligan = "Mulligan".equals(extra.get(LEFT_BUTTON)) && "Keep".equals(extra.get(RIGHT_BUTTON));
        add(mulligan ? "mulligan" : "yes", button(extra.get(LEFT_BUTTON), "Yes"), null, null, false,
            new BooleanAnswer(true));
        add(mulligan ? "keep" : "no", button(extra.get(RIGHT_BUTTON), "No"), null, null, false,
            new BooleanAnswer(false));
    }

    private void target(PlayerQueryEvent event, Map<String, Serializable> extra) {
        Set<UUID> chosen = uuids(extra.get("chosenTargets"));
        Set<UUID> candidates = new LinkedHashSet<>();
        // Cards listed in the request are shown to this seat by the request itself (a search of its
        // own library, for instance); only the selectable ones become options.
        boolean shownByRequest = event.getCards() != null;
        if (event.getCards() != null) {
            Set<UUID> selectable = extra.containsKey("possibleTargets")
                ? uuids(extra.get("possibleTargets")) : event.getCards();
            for (UUID id : event.getCards()) {
                if (selectable.contains(id)) {
                    candidates.add(id);
                }
            }
        } else if (event.getPerms() != null) {
            event.getPerms().forEach(permanent -> candidates.add(permanent.getId()));
        } else if (event.getTargets() != null) {
            candidates.addAll(event.getTargets());
        }
        candidates.addAll(chosen);

        List<UUID> players = candidates.stream().filter(id -> game.getPlayer(id) != null)
            .sorted(Comparator.comparingInt(views::seatOf)).toList();
        List<UUID> objects = candidates.stream().filter(id -> game.getPlayer(id) == null)
            .sorted(Comparator.comparing((UUID id) -> visibleLabel(id, shownByRequest),
                Comparator.nullsLast(Comparator.naturalOrder())).thenComparing(views::objectRef)).toList();
        for (UUID id : players) {
            add("choose", game.getPlayer(id).getName(), null, views.seatOf(id), chosen.contains(id),
                new UuidAnswer(id));
        }
        for (UUID id : objects) {
            add("choose", visibleLabel(id, shownByRequest), views.objectRef(id), null, chosen.contains(id),
                new UuidAnswer(id));
        }
        if (!event.isRequired()) {
            add("done", "Done", null, null, false, new BooleanAnswer(true));
        }
    }

    /**
     * Every way to pay that XMage counted when it listed the spell as castable: mana abilities on the
     * battlefield and in the hand (Simian Spirit Guide's, for instance), the pool, and special
     * payments such as convoke, delve and improvise. Sources and pool mana that cannot pay any of
     * the unpaid cost are left out: XMage would tap the source anyway, and answers it with pool mana
     * it cannot use by asking again, forever. With nothing that can pay, cancel is the only option
     * (Chain Lightning's "Pay {R}{R} to copy the spell?" answered yes by a player with only Forests).
     *
     * @param unpaid the cost still to pay, or null when it is unknown (then nothing is left out)
     */
    private void payMana(ManaCost unpaid) {
        List<Permanent> sources = new ArrayList<>();
        for (Permanent permanent : game.getBattlefield().getAllActivePermanents(player.getId())) {
            if (canProduceMana(permanent, unpaid)) {
                sources.add(permanent);
            }
        }
        sources.sort(Comparator.comparing(Permanent::getName).thenComparing(views::ref));
        for (Permanent permanent : sources) {
            add("tap_source", permanent.getName(), views.ref(permanent), null, false,
                new UuidAnswer(permanent.getId()));
        }
        // XMage takes a hand card's id as it takes a permanent's, and uses its mana ability. The
        // label is the ability ("Exile Simian Spirit Guide from your hand: Add {R}."): it costs a card.
        List<Card> handSources = new ArrayList<>();
        for (Card card : player.getHand().getCards(game)) {
            if (handManaAbilities(card).stream().anyMatch(ability -> pays(ability, unpaid))) {
                handSources.add(card);
            }
        }
        handSources.sort(Comparator.comparing(Card::getName).thenComparing(views::ref));
        for (Card card : handSources) {
            String rule = SeatViews.plain(handManaAbilities(card).get(0).getRule(card.getName()));
            add("tap_source", rule.isEmpty() ? card.getName() : rule, views.ref(card), null, false,
                new UuidAnswer(card.getId()));
        }
        ManaPool pool = player.getManaPool();
        for (ManaType type : ManaType.values()) {
            int amount = pool.get(type);
            if (amount > 0 && (unpaid == null || one(type) == null || unpaid.testPay(one(type)))) {
                add("use_pool", amount + " " + type + " mana in pool", null, null, false,
                    new ManaAnswer(player.getId(), type));
            }
        }
        // XMage's own condition for its Special button. XMage then asks which special payment, and
        // which creatures, cards or artifacts it uses.
        if (!game.getState().getSpecialActions().getControlledBy(player.getId(), true).isEmpty()) {
            add("special_payment", "Special payment (convoke, delve, improvise)", null, null, false,
                new StringAnswer("special"));
        }
        add("cancel", "Cancel", null, null, false, new BooleanAnswer(false));
    }

    /** Splitting an amount, such as combat damage among blockers: XMage's suggestion or a custom split. */
    private PromptView.Amounts amounts(PlayerQueryEvent event, Map<String, Serializable> extra) {
        List<PromptView.AmountEntry> entries = new ArrayList<>();
        List<Integer> suggested = new ArrayList<>();
        List<MultiAmountMessage> messages = event.getMessages() == null ? List.of() : event.getMessages();
        List<Integer> defaults = MultiAmountType.prepareDefaultValues(messages, event.getMin(), event.getMax());
        for (int i = 0; i < messages.size(); i++) {
            MultiAmountMessage entry = messages.get(i);
            entries.add(new PromptView.AmountEntry(SeatViews.plain(entry.message), entry.min, entry.max,
                defaults.get(i)));
            suggested.add(defaults.get(i));
        }
        add("suggested", "Use the suggested split " + suggested, null, null, false,
            new StringAnswer(encode(suggested)));
        if (Boolean.TRUE.equals(extra.get("canCancel"))) {
            add("cancel", "Cancel", null, null, false, new BooleanAnswer(true));
        }
        return new PromptView.Amounts(event.getMin(), event.getMax(), List.copyOf(entries));
    }

    /** XMage's answer format for a split: the amounts separated by spaces. */
    static String encode(List<Integer> values) {
        return String.join(" ", values.stream().map(String::valueOf).toList());
    }

    /** The mana abilities the seat can use from its hand, as XMage counts them for castable spells. */
    private Abilities<ActivatedManaAbilityImpl> handManaAbilities(Card card) {
        return card.getAbilities(game).getAvailableActivatedManaAbilities(Zone.HAND, player.getId(), game);
    }

    /**
     * The cost a payment request is for. XMage's request does not carry it, but its message is
     * "Pay " followed by the unpaid cost's symbols and, in a div, the source's name. Null if the
     * message does not read that way.
     */
    static ManaCost unpaidCost(String message) {
        if (message == null || !message.startsWith("Pay {")) {
            return null;
        }
        String text = message.substring("Pay ".length());
        int markup = text.indexOf('<');
        text = markup < 0 ? text : text.substring(0, markup);
        int last = text.lastIndexOf('}');
        if (last < 0) {
            return null;
        }
        try {
            ManaCostsImpl<ManaCost> cost = new ManaCostsImpl<>(text.substring(0, last + 1));
            return cost.isEmpty() ? null : cost;
        } catch (RuntimeException e) {
            return null;
        }
    }

    /**
     * Whether an effect lets mana be spent as though it were mana of another type (Chromatic Orrery,
     * for instance): then a source's colour does not rule it out.
     */
    private boolean spendsAsOtherTypes() {
        return !game.getContinuousEffects().getApplicableAsThoughEffects(AsThoughEffectType.SPEND_OTHER_MANA, game)
            .isEmpty();
    }

    /** Whether some mana the ability makes could pay part of the cost; true when either is unknown. */
    private boolean pays(ActivatedManaAbilityImpl ability, ManaCost unpaid) {
        if (unpaid == null) {
            return true;
        }
        List<Mana> made = ability.getNetMana(game);
        return made == null || made.isEmpty()
            || made.stream().anyMatch(mana -> mana.count() == 0 || unpaid.testPay(mana));
    }

    /** One mana of a pool type, or null for a type with no single mana. */
    private static Mana one(ManaType type) {
        return switch (type) {
            case WHITE -> Mana.WhiteMana(1);
            case BLUE -> Mana.BlueMana(1);
            case BLACK -> Mana.BlackMana(1);
            case RED -> Mana.RedMana(1);
            case GREEN -> Mana.GreenMana(1);
            case COLORLESS -> Mana.ColorlessMana(1);
            default -> null;
        };
    }

    private boolean canProduceMana(Permanent permanent, ManaCost unpaid) {
        if (!permanent.canUseActivatedAbilities(game)) {
            return false;
        }
        for (ActivatedManaAbilityImpl ability : permanent.getAbilities().getActivatedManaAbilities(Zone.BATTLEFIELD)) {
            if (ability.canActivate(player.getId(), game).canActivate() && pays(ability, unpaid)) {
                return true;
            }
        }
        return false;
    }

    /** Creatures the seat may toggle, including those already declared. */
    /**
     * The possible blockers that can block one of the attackers now (v0.6.3). XMage lists every
     * creature able to block something, and only asks which attacker after one is picked; with none
     * it can block (a flier, an attacker it cannot block, one attacking someone else), that question
     * offers nothing, and Done asks for blockers again, forever (the owner's Varragoth, Bloodsky
     * Sire). This is XMage's own test (HumanPlayer.selectCombatGroup), so a creature offered here
     * always has an attacker to choose.
     */
    private Set<UUID> canBlockAny(Set<UUID> possible) {
        Set<UUID> attackers = new TargetAttackingCreature().possibleTargets(player.getId(), null, game);
        Set<UUID> able = new LinkedHashSet<>();
        for (UUID id : possible) {
            Permanent blocker = game.getPermanent(id);
            if (blocker == null) {
                continue;
            }
            for (UUID attacker : attackers) {
                CombatGroup group = game.getCombat().findGroup(attacker);
                if (group != null && group.canBlock(blocker, game)) {
                    able.add(id);
                    break;
                }
            }
        }
        return able;
    }

    private void combatants(Set<UUID> possible, Set<UUID> declared, String action) {
        Set<UUID> creatures = new LinkedHashSet<>(possible);
        for (UUID id : declared) {
            Permanent permanent = game.getPermanent(id);
            if (permanent != null && player.getId().equals(permanent.getControllerId())) {
                creatures.add(id);
            }
        }
        List<UUID> sorted = new ArrayList<>(creatures);
        sorted.sort(Comparator.comparing(this::label, Comparator.nullsLast(Comparator.naturalOrder()))
            .thenComparing(views::objectRef));
        for (UUID id : sorted) {
            add(action, label(id), views.objectRef(id), null, declared.contains(id), new UuidAnswer(id));
        }
    }

    private String visibleLabel(UUID id, boolean shownByRequest) {
        return shownByRequest || Visibility.identityVisible(game, id, player.getId()) ? label(id) : null;
    }

    private String label(UUID id) {
        MageObject object = game.getObject(id);
        return object == null ? null : object.getName();
    }

    private int zoneRank(UUID id) {
        Zone zone = game.getState().getZone(id);
        if (zone == Zone.HAND) {
            return 0;
        }
        return zone == Zone.BATTLEFIELD ? 1 : 2;
    }

    private void add(String action, String label, String objectId, Integer seat, boolean selected, Answer answer) {
        String id = String.valueOf(options.size() + 1);
        options.add(new PromptView.Option(id, action, label, objectId, seat, selected));
        answers.put(id, answer);
    }

    private static String button(Serializable text, String fallback) {
        return text instanceof String value && !SeatViews.plain(value).isEmpty() ? SeatViews.plain(value) : fallback;
    }

    private static Set<UUID> uuids(Object value) {
        Set<UUID> ids = new LinkedHashSet<>();
        if (value instanceof Collection<?> collection) {
            for (Object item : collection) {
                if (item instanceof UUID id) {
                    ids.add(id);
                }
            }
        }
        return ids;
    }
}
