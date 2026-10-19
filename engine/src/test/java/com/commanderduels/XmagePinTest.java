package com.commanderduels;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import mage.utils.MageVersion;
import org.junit.jupiter.api.Test;

class XmagePinTest {
    @Test
    void pinMatchesTheXmageBuildOnTheClasspath() {
        XmagePin pin = XmagePin.load();
        assertTrue(pin.commit().matches("[0-9a-f]{40}"), "full commit SHA");
        String built = MageVersion.MAGE_VERSION_MAJOR + "." + MageVersion.MAGE_VERSION_MINOR + "."
            + MageVersion.MAGE_VERSION_RELEASE;
        assertEquals(built, pin.version(), "pin.properties and the compiled XMage disagree");
        assertEquals(built, System.getProperty("xmage.version"), "engine/pom.xml xmage.version");
    }
}
