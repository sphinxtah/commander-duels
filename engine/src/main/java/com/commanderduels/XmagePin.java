package com.commanderduels;

import java.io.IOException;
import java.io.InputStream;
import java.io.UncheckedIOException;
import java.util.Properties;

/** The pinned XMage build, read from engine/xmage/pin.properties (packaged on the classpath). */
public record XmagePin(String version, String tag, String commit, String commitDate) {
    public static XmagePin load() {
        var properties = new Properties();
        try (InputStream stream = XmagePin.class.getResourceAsStream("/xmage/pin.properties")) {
            if (stream == null) {
                throw new IllegalStateException("xmage/pin.properties is missing from the classpath");
            }
            properties.load(stream);
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
        return new XmagePin(
            require(properties, "xmage.version"),
            require(properties, "xmage.tag"),
            require(properties, "xmage.commit"),
            require(properties, "xmage.commit_date"));
    }

    private static String require(Properties properties, String key) {
        String value = properties.getProperty(key, "").trim();
        if (value.isEmpty()) {
            throw new IllegalStateException("xmage/pin.properties has no " + key);
        }
        return value;
    }
}
