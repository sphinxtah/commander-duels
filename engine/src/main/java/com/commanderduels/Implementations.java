package com.commanderduels;

import com.google.gson.Gson;
import com.google.gson.JsonParseException;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Optional;

/**
 * The engine's list of the cards it implements, with the automatic gates each passed (CAT09). The
 * image makes it once per XMage pin (engine/xmage/ExportImplementations.java):
 * {@code implementations.json.gz}, served as it is to the catalog, and {@code implementations.build},
 * its build ID and counts, which /health names so the catalog fetches a list only when it changes.
 */
final class Implementations {
    static final String LIST = "implementations.json.gz";
    static final String SUMMARY = "implementations.build";

    record Summary(String build, long cards, long passed) {}

    private final Path folder;
    private final Summary summary;

    private Implementations(Path folder, Summary summary) {
        this.folder = folder;
        this.summary = summary;
    }

    /** No list: a development engine built without the image's export stage. */
    static Implementations none() {
        return new Implementations(null, null);
    }

    static Implementations load(Path folder) {
        Path file = folder.resolve(SUMMARY);
        if (!Files.isRegularFile(file) || !Files.isRegularFile(folder.resolve(LIST))) {
            return none();
        }
        try {
            Summary summary = new Gson().fromJson(Files.readString(file, StandardCharsets.UTF_8), Summary.class);
            if (summary == null || summary.build() == null || summary.build().isBlank()) {
                return none();
            }
            return new Implementations(folder, summary);
        } catch (IOException | JsonParseException e) {
            System.err.println("The implementation list's summary could not be read: " + e.getMessage());
            return none();
        }
    }

    Summary summary() {
        return summary;
    }

    Optional<Path> list() {
        return summary == null ? Optional.empty() : Optional.of(folder.resolve(LIST));
    }
}
