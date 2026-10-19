# XMage patches

Changes to upstream XMage live here as `NNNN-description.patch` files (`git diff` format, paths relative to the XMage root). `build-xmage.sh` applies them in name order after fetching the pinned commit, and the build fails if one no longer applies.

Each patch needs a header comment that gives the reason, the upstream issue or pull request if there is one, and the condition for removing it.

None are needed at the current pin (`xmage_1.4.62V1`).
