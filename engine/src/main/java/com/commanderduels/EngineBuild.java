package com.commanderduels;

import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HexFormat;
import java.util.List;
import java.util.stream.Stream;

/**
 * One key for the code this engine runs (v0.9.9): a digest of everything on its class path, which is
 * the engine's own classes, XMage with the patches it was built with, every card's implementation
 * and any plugin's cards. A game's recording is bound to the key of the engine that made it
 * ({@link Recording.Binding}), and the game goes on only in an engine with the same key: a saved
 * state is those classes' objects, and the rules and cards of another build would not play the same
 * game. Two engines started from the same image have the same key. An image built anew has
 * another, even from the same sources (a jar carries the times its files were built), so every
 * release's engine has its own.
 *
 * <p>The entries are digested in the order of their names, not of the class path, since a class
 * path given with a wildcard ({@code lib/*}) lists a folder's jars in no set order.
 */
final class EngineBuild {
    private static volatile String key;

    private EngineBuild() {}

    /** This engine's key; worked out once, the first time it is asked for. */
    static String key() {
        String known = key;
        if (known == null) {
            synchronized (EngineBuild.class) {
                known = key;
                if (known == null) {
                    // A game's own process (v0.9.10) runs its front process's class path, whose key
                    // the front process hands it rather than have each game digest it again.
                    String given = "game".equals(System.getenv("CD_ENGINE_ROLE"))
                        ? System.getenv("CD_ENGINE_BUILD_KEY") : null;
                    known = given != null && !given.isBlank() ? given.strip()
                        : of(System.getProperty("java.class.path", ""));
                    key = known;
                }
            }
        }
        return known;
    }

    /** The key of a class path: for tests. */
    static String of(String classPath) {
        List<Path> entries = new ArrayList<>();
        for (String entry : classPath.split(File.pathSeparator)) {
            if (!entry.isBlank()) {
                entries.add(Path.of(entry));
            }
        }
        entries.sort(Comparator.comparing(path -> path.getFileName() == null ? "" : path.getFileName().toString()));
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            for (Path entry : entries) {
                if (Files.isDirectory(entry)) {
                    try (Stream<Path> files = Files.walk(entry)) {
                        for (Path file : files.filter(Files::isRegularFile).sorted().toList()) {
                            digest.update(entry.relativize(file).toString().replace(File.separatorChar, '/')
                                .getBytes(StandardCharsets.UTF_8));
                            update(digest, file);
                        }
                    }
                } else if (Files.isRegularFile(entry)) {
                    digest.update(entry.getFileName().toString().getBytes(StandardCharsets.UTF_8));
                    update(digest, entry);
                }
            }
            return HexFormat.of().formatHex(digest.digest(), 0, 16);
        } catch (IOException | NoSuchAlgorithmException e) {
            // An engine that cannot tell what it runs binds its recordings to nothing another has.
            return "unknown-" + Long.toHexString(System.nanoTime());
        }
    }

    private static void update(MessageDigest digest, Path file) throws IOException {
        byte[] buffer = new byte[1 << 16];
        try (InputStream in = Files.newInputStream(file)) {
            for (int read = in.read(buffer); read >= 0; read = in.read(buffer)) {
                digest.update(buffer, 0, read);
            }
        }
    }
}
