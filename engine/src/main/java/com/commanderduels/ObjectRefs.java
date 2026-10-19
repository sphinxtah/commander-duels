package com.commanderduels;

import java.security.SecureRandom;
import java.util.HashMap;
import java.util.HexFormat;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;

/**
 * Opaque object ids for one game. Clients never see XMage's UUIDs. An object that changes zones is a
 * new object (rule 400.7), so the key includes XMage's zone-change counter and a card that leaves
 * and re-enters play gets a new id. Ids are random, so they carry no ordering or identity
 * information, and they are minted only when an object is first shown to a seat.
 */
final class ObjectRefs {
    private static final SecureRandom RANDOM = new SecureRandom();
    private static final HexFormat HEX = HexFormat.of();

    private record Key(UUID id, int zoneChangeCounter) {}

    private final Map<Key, String> refs = new HashMap<>();
    private final Map<String, Key> keys = new HashMap<>();

    synchronized String ref(UUID id, int zoneChangeCounter) {
        Key key = new Key(id, zoneChangeCounter);
        String ref = refs.get(key);
        if (ref == null) {
            do {
                byte[] bytes = new byte[8];
                RANDOM.nextBytes(bytes);
                ref = "o" + HEX.formatHex(bytes);
            } while (keys.containsKey(ref));
            refs.put(key, ref);
            keys.put(ref, key);
        }
        return ref;
    }

    /** The XMage object behind a ref; for tests and diagnostics, never for client input. */
    synchronized Optional<UUID> resolve(String ref) {
        return Optional.ofNullable(keys.get(ref)).map(Key::id);
    }

    synchronized int size() {
        return refs.size();
    }
}
