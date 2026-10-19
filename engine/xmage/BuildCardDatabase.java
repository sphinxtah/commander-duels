import java.util.ArrayList;
import java.util.List;
import mage.cards.repository.CardRepository;
import mage.cards.repository.CardScanner;

/**
 * Image-build step: scans the pinned XMage card classes into ./db/cards.h2 once, so engine startup
 * only opens the finished database. Run with the JDK single-file launcher in the XMage build stage.
 */
public final class BuildCardDatabase {
    public static void main(String[] args) {
        long started = System.nanoTime();
        List<String> errors = new ArrayList<>();
        CardScanner.scan(errors);
        if (!errors.isEmpty()) {
            errors.forEach(System.err::println);
            System.exit(1);
        }
        List<List<String>> counts = CardRepository.instance.querySQL(
            "SELECT COUNT(*), COUNT(DISTINCT name) FROM card");
        long seconds = (System.nanoTime() - started) / 1_000_000_000L;
        Runtime runtime = Runtime.getRuntime();
        System.out.printf("Card database built in %ds: %s printings, %s distinct names, heap used %d MB%n",
            seconds, counts.get(0).get(0), counts.get(0).get(1),
            (runtime.totalMemory() - runtime.freeMemory()) / (1024 * 1024));
        CardRepository.instance.closeDB(true);
        System.exit(0);
    }
}
