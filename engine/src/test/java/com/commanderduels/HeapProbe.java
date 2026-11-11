package com.commanderduels;

import java.lang.management.ManagementFactory;
import java.lang.management.MemoryMXBean;
import java.lang.management.MemoryUsage;
import java.util.ArrayList;
import java.util.List;
import javax.management.ObjectName;

/**
 * What fills the heap (v0.9.8), for the measured games of {@link CampaignDifficulty}: with
 * {@code -Dcampaign.probe=<share>} a thread watches the heap, and whenever more than that share of it
 * is in use it asks the JVM for a histogram of the live objects (which collects first) and prints one
 * line: the live megabytes, how many game copies, game states and search nodes are alive, and the
 * classes holding the most. The court's memory (docs/engine/fair-bots.md) was read from these lines.
 * A histogram stops the JVM for a moment, so the probe is for looking, never for a measured run.
 */
final class HeapProbe {
    private HeapProbe() {}

    static void start(double share) {
        Thread thread = new Thread(() -> watch(share), "heap-probe");
        thread.setDaemon(true);
        thread.start();
    }

    private static void watch(double share) {
        MemoryMXBean memory = ManagementFactory.getMemoryMXBean();
        long last = 0;
        while (true) {
            try {
                Thread.sleep(1_000);
            } catch (InterruptedException e) {
                return;
            }
            MemoryUsage heap = memory.getHeapMemoryUsage();
            if ((double) heap.getUsed() / heap.getMax() < share || System.nanoTime() - last < 10_000_000_000L) {
                continue;
            }
            last = System.nanoTime();
            try {
                System.out.println("PROBE used " + heap.getUsed() / (1024 * 1024) + " MB before; " + summary(histogram()));
            } catch (Exception | OutOfMemoryError e) {
                System.out.println("PROBE failed: " + e);
            }
        }
    }

    static String histogram() throws Exception {
        return (String) ManagementFactory.getPlatformMBeanServer().invoke(
            new ObjectName("com.sun.management:type=DiagnosticCommand"), "gcClassHistogram",
            new Object[] {new String[0]}, new String[] {String[].class.getName()});
    }

    /** One line of a histogram: the totals, the game copies and search nodes alive, and the heaviest classes. */
    static String summary(String histogram) {
        long total = 0;
        long games = 0;
        long states = 0;
        long nodes = 0;
        List<String> top = new ArrayList<>();
        for (String line : histogram.split("\n")) {
            String[] parts = line.trim().split("\\s+");
            if (parts.length >= 3 && parts[0].equals("Total")) {
                total = Long.parseLong(parts[2]);
            }
            if (parts.length < 4 || !parts[0].endsWith(":")) {
                continue;
            }
            long instances = Long.parseLong(parts[1]);
            String name = parts[3];
            if (name.startsWith("com.commanderduels.") && name.endsWith("Game")
                    || name.equals("mage.game.CommanderFreeForAll") || name.equals("mage.game.TwoPlayerDuel")) {
                games += instances;
            } else if (name.equals("mage.game.GameState")) {
                states = instances;
            } else if (name.equals("mage.player.ai.SimulationNode2")) {
                nodes = instances;
            }
            if (top.size() < 6) {
                top.add(name + " " + Long.parseLong(parts[2]) / (1024 * 1024) + " MB");
            }
        }
        return "live " + total / (1024 * 1024) + " MB, " + games + " game copies, " + states + " game states, "
            + nodes + " search nodes" + (games > 0 ? ", " + total / games / (1024 * 1024) + " MB a copy" : "")
            + "; heaviest: " + top;
    }
}
