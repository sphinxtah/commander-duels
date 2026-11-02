package com.commanderduels;

import static org.junit.jupiter.api.Assertions.assertEquals;

import java.util.ArrayList;
import java.util.List;
import java.util.Random;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.atomic.AtomicReference;
import mage.util.RandomUtil;
import org.junit.jupiter.api.Test;

/**
 * Each game draws from its own generator (patch 0010, v0.8.5): seeding one thread neither reseeds nor
 * advances another thread's generator, so a seed repeats its game while other games start and run.
 */
class PerGameRandomTest {
    private static List<Integer> expected(long seed, int count) {
        Random random = new Random(seed);
        List<Integer> draws = new ArrayList<>();
        for (int i = 0; i < count; i++) {
            draws.add(random.nextInt(1000));
        }
        return draws;
    }

    @Test
    void anotherThreadsSeedDoesNotChangeThisThreadsDraws() throws Exception {
        CountDownLatch firstHalf = new CountDownLatch(1);
        CountDownLatch otherSeeded = new CountDownLatch(1);
        AtomicReference<List<Integer>> game = new AtomicReference<>();
        Thread gameThread = new Thread(() -> {
            RandomUtil.setSeed(7);
            List<Integer> draws = new ArrayList<>();
            for (int i = 0; i < 3; i++) {
                draws.add(RandomUtil.nextInt(1000));
            }
            firstHalf.countDown();
            try {
                otherSeeded.await();
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                return;
            }
            for (int i = 0; i < 3; i++) {
                draws.add(RandomUtil.getRandom().nextInt(1000));
            }
            game.set(draws);
        });
        gameThread.start();
        firstHalf.await();
        // A second game starts with a known seed and draws while the first is running.
        RandomUtil.setSeed(20261031L);
        List<Integer> other = new ArrayList<>();
        for (int i = 0; i < 4; i++) {
            other.add(RandomUtil.nextInt(1000));
        }
        otherSeeded.countDown();
        gameThread.join(10_000);
        RandomUtil.clearSeed();

        assertEquals(expected(7, 6), game.get(), "the first game's stream is its seed's alone");
        assertEquals(expected(20261031L, 4), other, "and so is the second's");
    }
}
