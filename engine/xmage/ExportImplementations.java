import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import java.io.FileInputStream;
import java.io.OutputStreamWriter;
import java.io.Writer;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Properties;
import java.util.TreeMap;
import java.util.TreeSet;
import java.util.zip.GZIPOutputStream;
import mage.cards.Card;
import mage.cards.CardWithHalves;
import mage.cards.CardWithSpellOption;
import mage.cards.repository.CardInfo;
import mage.cards.repository.CardRepository;
import mage.cards.repository.CardScanner;

/**
 * Image-build step: the engine's list of what it implements, with the automatic gates (CAT09).
 *
 * <p>Every card name in the card database is resolved as games resolve it (XMage's preferred
 * printing), and its class must: create a card of that name; describe it (rules text, cost, types,
 * power, toughness, loyalty, defense); load its other faces (split halves, both sides of a
 * double-faced card, an adventure's spell, a meld result); and make a copy, as game states copy
 * cards. Split halves and back faces are listed with their card, not alone. The catalog compares
 * the list with Scryfall's cards and certifies those that pass.
 *
 * <p>Writes implementations.json.gz and implementations.build (the build ID) to the folder named
 * by the first argument. The build ID names the XMage pin and the list's own SHA-256, so it changes
 * whenever the list does. Run with the JDK single-file launcher after the card database is built.
 */
public final class ExportImplementations {
    private static final int MAX_ERROR = 300;

    public static void main(String[] args) throws Exception {
        long started = System.nanoTime();
        Path folder = Path.of(args[0]);
        Files.createDirectories(folder);
        Properties pin = new Properties();
        try (var in = new FileInputStream(args[1])) {
            pin.load(in);
        }
        CardScanner.scanned = true;
        // A face's name ("Fire", "Stomp") resolves to its whole card, and a split card's joined
        // name is not among the names: each card is listed once, under the name its class gives it.
        Map<String, Map<String, Object>> listed = new TreeMap<>();
        for (String name : new TreeSet<>(CardRepository.instance.getNames())) {
            CardInfo info = CardRepository.instance.findPreferredCoreExpansionCard(name);
            if (info == null) {
                listed.putIfAbsent(name, unresolved(name));
                continue;
            }
            if (info.isSplitCardHalf() || info.isNightCard()) {
                continue;
            }
            Card created = null;
            Throwable failure = null;
            try {
                created = info.createCard();
            } catch (Throwable error) {
                failure = error;
            }
            String actual = created == null ? name : created.getName();
            if (!listed.containsKey(actual)) {
                listed.put(actual, export(actual, info, created, failure));
            }
        }
        List<Map<String, Object>> cards = new ArrayList<>(listed.values());
        long passed = cards.stream().filter(card -> Boolean.TRUE.equals(card.get("passed"))).count();
        Gson gson = new GsonBuilder().disableHtmlEscaping().create();
        String json = gson.toJson(cards);
        String digest = HexFormat.of().formatHex(
            MessageDigest.getInstance("SHA-256").digest(json.getBytes(StandardCharsets.UTF_8)));
        String build = pin.getProperty("xmage.version") + "-" + pin.getProperty("xmage.commit").substring(0, 8)
            + "-" + digest.substring(0, 12);
        Map<String, Object> export = new LinkedHashMap<>();
        export.put("build", build);
        export.put("xmage", pin.getProperty("xmage.tag"));
        export.put("cards", cards);
        try (Writer out = new OutputStreamWriter(
                new GZIPOutputStream(Files.newOutputStream(folder.resolve("implementations.json.gz"))),
                StandardCharsets.UTF_8)) {
            gson.toJson(export, out);
        }
        Map<String, Object> summary = new LinkedHashMap<>();
        summary.put("build", build);
        summary.put("cards", cards.size());
        summary.put("passed", passed);
        Files.writeString(folder.resolve("implementations.build"), gson.toJson(summary) + "\n");
        Runtime runtime = Runtime.getRuntime();
        System.out.printf("Implementation list %s: %d cards, %d passed every gate, in %ds, heap used %d MB%n",
            build, cards.size(), passed, (System.nanoTime() - started) / 1_000_000_000L,
            (runtime.totalMemory() - runtime.freeMemory()) / (1024 * 1024));
        CardRepository.instance.closeDB(true);
        System.exit(0);
    }

    private static Map<String, Object> unresolved(String name) {
        Map<String, Object> card = new LinkedHashMap<>();
        Map<String, Object> gates = new LinkedHashMap<>();
        gates.put("resolves", false);
        card.put("name", name);
        card.put("gates", gates);
        card.put("passed", false);
        return card;
    }

    private static Map<String, Object> export(String name, CardInfo info, Card created, Throwable failure) {
        Map<String, Object> card = new LinkedHashMap<>();
        Map<String, Object> gates = new LinkedHashMap<>();
        card.put("name", name);
        card.put("gates", gates);
        card.put("passed", false);
        card.put("class", info.getClassName());
        card.put("kind", kind(info));
        card.put("set", info.getSetCode());
        card.put("number", info.getCardNumber());
        // Games resolve a deck list's names this way (DeckLists.find), so the name must lead back to
        // this class.
        CardInfo again = CardRepository.instance.findPreferredCoreExpansionCard(name);
        gates.put("resolves", again != null && info.getClassName().equals(again.getClassName()));
        if (failure != null) {
            return failed(card, gates, "creates", failure);
        }
        gates.put("creates", created != null);
        if (created == null) {
            gates.put("error", "the class made no card");
            return card;
        }
        try {
            card.putAll(describe(created));
            gates.put("describes", true);
        } catch (Throwable error) {
            return failed(card, gates, "describes", error);
        }
        try {
            List<Map<String, Object>> faces = new ArrayList<>();
            for (Card face : faces(created)) {
                Map<String, Object> described = describe(face);
                described.put("name", face.getName());
                faces.add(described);
            }
            card.put("faces", faces);
            gates.put("faces", true);
        } catch (Throwable error) {
            return failed(card, gates, "faces", error);
        }
        try {
            Card copy = created.copy();
            gates.put("copies", copy != null && name.equals(copy.getName()));
        } catch (Throwable error) {
            return failed(card, gates, "copies", error);
        }
        card.put("passed", gates.values().stream().allMatch(Boolean.TRUE::equals));
        return card;
    }

    private static Map<String, Object> failed(Map<String, Object> card, Map<String, Object> gates, String gate,
                                              Throwable error) {
        gates.put(gate, false);
        String message = error.getClass().getSimpleName() + (error.getMessage() == null ? "" : ": " + error.getMessage());
        gates.put("error", message.length() > MAX_ERROR ? message.substring(0, MAX_ERROR) : message);
        return card;
    }

    private static Map<String, Object> describe(Card card) {
        Map<String, Object> described = new LinkedHashMap<>();
        described.put("mana_cost", card.getManaCost().getText());
        described.put("types", card.getCardType().stream().map(type -> type.toString()).toList());
        described.put("subtypes", card.getSubtype().stream().map(type -> type.toString()).toList());
        described.put("supertypes", card.getSuperType().stream().map(type -> type.toString()).toList());
        if (card.getPower() != null && card.isCreature()) {
            described.put("power", card.getPower().toString());
            described.put("toughness", card.getToughness().toString());
        }
        if (card.getStartingLoyalty() >= 0 && card.isPlaneswalker()) {
            described.put("loyalty", Integer.toString(card.getStartingLoyalty()));
        }
        if (card.getStartingDefense() >= 0 && card.isBattle()) {
            described.put("defense", Integer.toString(card.getStartingDefense()));
        }
        described.put("rules", card.getRules());
        return described;
    }

    private static List<Card> faces(Card card) {
        List<Card> faces = new ArrayList<>();
        if (card instanceof CardWithHalves halves) {
            faces.add(halves.getLeftHalfCard());
            faces.add(halves.getRightHalfCard());
        } else if (card instanceof CardWithSpellOption option) {
            faces.add(option.getSpellCard());
        } else if (card.isTransformable() && card.getSecondCardFace() != null) {
            faces.add(card.getSecondCardFace());
        }
        if (card.getMeldsToCard() != null) {
            faces.add(card.getMeldsToCard());
        }
        faces.removeIf(face -> face == null);
        return faces;
    }

    private static String kind(CardInfo info) {
        if (info.isSplitCard()) {
            return "split";
        } else if (info.isFlipCard()) {
            return "flip";
        } else if (info.isMeldCard()) {
            return "meld";
        } else if (info.isDoubleFacedCard()) {
            return "modal_dfc";
        } else if (info.isDoubleFaced()) {
            return "transform";
        } else if (info.isCardWithSpellOption()) {
            return "adventure";
        }
        return "normal";
    }
}
