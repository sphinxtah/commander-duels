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
import mage.game.events.PlayerQueryEvent;
import mage.game.permanent.Permanent;
import mage.player.human.HumanPlayer;
import mage.players.ManaPool;
import mage.players.Player;
import mage.util.MultiAmountMessage;

/**
 * Turns XMage's {@link PlayerQueryEvent}s for a human seat into typed prompts. Each option maps to
 * the answer XMage's {@code HumanPlayer} expects (a UUID, boolean or string), so the seat never
 * sends XMage identifiers itself. XMage validates the answer again and asks again if it rejects it.
 * Runs on the game thread, while XMage is about to wait for the answer.
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

        /** Names in the list that start like the text, alphabetically, for a refusal to suggest. */
        List<String> near(String text) {
            if (names == null) {
                return List.of();
            }
            String start = fold(text);
            return names.entrySet().stream().filter(entry -> entry.getKey().startsWith(start))
                .map(Map.Entry::getValue).sorted().limit(MAX_NEAR_NAMES).toList();
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
    private final HumanPlayer human;
    private final SeatViews views;
    private final List<PromptView.Option> options = new ArrayList<>();
    private final Map<String, Answer> answers = new LinkedHashMap<>();

    private Prompts(Game game, HumanPlayer human, SeatViews views) {
        this.game = game;
        this.human = human;
        this.views = views;
    }

    /**
     * @param attacker the attacker the seat last toggled, which a defender choice is about; XMage's
     *                 request does not name it
     */
    static Prompt build(PlayerQueryEvent event, Game game, HumanPlayer human, SeatViews views, String promptId,
                        String attacker) {
        Prompt prompt = new Prompts(game, human, views).from(event, promptId);
        if (prompt.view().kind().equals("choose_defender") && prompt.view().detail() == null && attacker != null) {
            PromptView view = prompt.view();
            prompt = new Prompt(new PromptView(view.id(), view.kind(), view.message(), "Attacker: " + attacker,
                view.options(), view.amounts(), view.piles(), view.xmageQuery()), prompt.answers(), prompt.names());
        }
        return prompt;
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
                    combatants(uuids(extra.get(Constants.Option.POSSIBLE_BLOCKERS)),
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
            null), Map.copyOf(answers), names);
    }

    private Prompt unsupported(PlayerQueryEvent event, String promptId, String message, String detail) {
        options.clear();
        answers.clear();
        return new Prompt(new PromptView(promptId, "unsupported", message, detail, List.of(), null, null,
            event.getQueryType().name()), Map.of(), null);
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

    /** Several of the seat's triggers at once: the one chosen goes on the stack first, and XMage asks again. */
    private void triggers(PlayerQueryEvent event) {
        List<? extends Ability> abilities = event.getAbilities() == null ? List.of() : event.getAbilities();
        for (Ability ability : abilities) {
            MageObject source = game.getObject(ability.getSourceId());
            boolean visible = Visibility.identityVisible(game, ability.getSourceId(), human.getId());
            String rule = SeatViews.plain(ability.getRule(source == null ? null : source.getName()));
            add("put_first", rule.isEmpty() ? ability.toString() : rule,
                visible ? views.objectRef(ability.getSourceId()) : null, null, false, new UuidAnswer(ability.getId()));
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
                if (Visibility.identityVisible(game, card.getId(), human.getId())) {
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
            if (accepted.contains(card.getName()) && Visibility.identityVisible(game, card.getId(), human.getId())) {
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
        for (Priority.Mode mode : Priority.MODES) {
            if (mode.xmage() != PlayerAction.PASS_PRIORITY_UNTIL_STACK_RESOLVED || !game.getStack().isEmpty()) {
                add(mode.action(), mode.label(), null, null, false, new PassAnswer(mode.xmage(), game));
            }
        }
        Map<UUID, List<ActivatedAbility>> byObject = new LinkedHashMap<>();
        for (ActivatedAbility ability : human.getPlayable(game, true, Zone.ALL, false)) {
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
        for (Permanent permanent : game.getBattlefield().getAllActivePermanents(human.getId())) {
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
        for (Card card : human.getHand().getCards(game)) {
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
        ManaPool pool = human.getManaPool();
        for (ManaType type : ManaType.values()) {
            int amount = pool.get(type);
            if (amount > 0 && (unpaid == null || one(type) == null || unpaid.testPay(one(type)))) {
                add("use_pool", amount + " " + type + " mana in pool", null, null, false,
                    new ManaAnswer(human.getId(), type));
            }
        }
        // XMage's own condition for its Special button. XMage then asks which special payment, and
        // which creatures, cards or artifacts it uses.
        if (!game.getState().getSpecialActions().getControlledBy(human.getId(), true).isEmpty()) {
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
        return card.getAbilities(game).getAvailableActivatedManaAbilities(Zone.HAND, human.getId(), game);
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
            if (ability.canActivate(human.getId(), game).canActivate() && pays(ability, unpaid)) {
                return true;
            }
        }
        return false;
    }

    /** Creatures the seat may toggle, including those already declared. */
    private void combatants(Set<UUID> possible, Set<UUID> declared, String action) {
        Set<UUID> creatures = new LinkedHashSet<>(possible);
        for (UUID id : declared) {
            Permanent permanent = game.getPermanent(id);
            if (permanent != null && human.getId().equals(permanent.getControllerId())) {
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
        return shownByRequest || Visibility.identityVisible(game, id, human.getId()) ? label(id) : null;
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
