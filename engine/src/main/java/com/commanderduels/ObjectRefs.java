package com.commanderduels;

import java.io.Serializable;
import java.nio.ByteBuffer;
import java.security.GeneralSecurityException;
import java.security.SecureRandom;
import java.util.HashMap;
import java.util.HexFormat;
import java.util.Optional;
import java.util.UUID;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

/**
 * Opaque object ids for one game. Clients never see XMage's UUIDs. An object that changes zones is a
 * new object (rule 400.7), so the key includes XMage's zone-change counter and a card that leaves
 * and re-enters play gets a new id. An id is a keyed digest of the object under a secret this game
 * alone holds, so to a client it is as good as random: it carries no ordering or identity
 * information, and it is minted only when an object is first shown to a seat.
 *
 * <p>Since v0.9.9 the ids are part of a game's checkpoint ({@link Checkpoint}), secret included: a
 * game that goes on after an interruption names every object by the id it had, also the ones a seat
 * was first shown after the checkpoint was taken, so what a seat was shown before and what it is
 * shown after refer to the same things.
 */
final class ObjectRefs implements Serializable {
    private static final long serialVersionUID = 2L;
    private static final SecureRandom RANDOM = new SecureRandom();
    private static final HexFormat HEX = HexFormat.of();
    private static final String DIGEST = "HmacSHA256";

    private record Key(UUID id, int zoneChangeCounter) implements Serializable {}

    private final byte[] secret;
    private final HashMap<Key, String> refs = new HashMap<>();
    private final HashMap<String, Key> keys = new HashMap<>();

    ObjectRefs() {
        this(fresh());
    }

    private ObjectRefs(byte[] secret) {
        this.secret = secret;
    }

    private static byte[] fresh() {
        byte[] secret = new byte[32];
        RANDOM.nextBytes(secret);
        return secret;
    }

    /** The ids as they are now, for a checkpoint: later ids are minted in the original alone. */
    synchronized ObjectRefs copy() {
        var copy = new ObjectRefs(secret.clone());
        copy.refs.putAll(refs);
        copy.keys.putAll(keys);
        return copy;
    }

    synchronized String ref(UUID id, int zoneChangeCounter) {
        Key key = new Key(id, zoneChangeCounter);
        String ref = refs.get(key);
        if (ref == null) {
            int attempt = 0;
            do {
                ref = derive(key, attempt++);
            } while (keys.containsKey(ref));
            refs.put(key, ref);
            keys.put(ref, key);
        }
        return ref;
    }

    /** Sixty-four bits of the keyed digest; a clash (never seen) moves on to the next attempt. */
    private String derive(Key key, int attempt) {
        try {
            Mac mac = Mac.getInstance(DIGEST);
            mac.init(new SecretKeySpec(secret, DIGEST));
            ByteBuffer input = ByteBuffer.allocate(24);
            input.putLong(key.id().getMostSignificantBits());
            input.putLong(key.id().getLeastSignificantBits());
            input.putInt(key.zoneChangeCounter());
            input.putInt(attempt);
            return "o" + HEX.formatHex(mac.doFinal(input.array()), 0, 8);
        } catch (GeneralSecurityException e) {
            throw new IllegalStateException(e);
        }
    }

    /** The XMage object behind a ref; for tests and diagnostics, never for client input. */
    synchronized Optional<UUID> resolve(String ref) {
        return Optional.ofNullable(keys.get(ref)).map(Key::id);
    }

    /** Whether this game has shown an object under the ref. */
    synchronized boolean knows(String ref) {
        return keys.containsKey(ref);
    }

    synchronized int size() {
        return refs.size();
    }
}
