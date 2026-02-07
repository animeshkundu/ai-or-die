# Visual Regression Baseline Update Workflow

When UI changes affect the visual appearance of components tested by `e2e/tests/09-visual-regression.spec.js`, the baseline screenshots must be updated.

## When baselines need updating

- Adding or removing context menu items
- Changing component layout, spacing, or colors
- Adding new UI elements to tested views (welcome screen, tabs, modals, tool cards)

## Baseline files

Baselines are stored in `e2e/tests/09-visual-regression.spec.js-snapshots/` with the naming pattern:

```
<test-name>-visual-regression-<platform>.png
```

Where `<platform>` is `linux` or `win32`. Both must be updated together.

## Update procedure

1. **Delete the stale baseline PNGs** that correspond to the changed component.

2. **Temporarily add `--update-snapshots`** to the CI visual regression command in `.github/workflows/ci.yml`:
   ```yaml
   run: npx playwright test --config e2e/playwright.config.js --project visual-regression --update-snapshots
   ```

3. **Push and let CI run.** The `test-browser-visual` job will generate new baselines instead of failing on mismatch. The generated screenshots are uploaded as the `screenshot-baselines-ubuntu-latest` and `screenshot-baselines-windows-latest` artifacts.

4. **Download the artifacts** using:
   ```bash
   gh run download <run-id> -n screenshot-baselines-ubuntu-latest -D ./tmp-baselines-linux
   gh run download <run-id> -n screenshot-baselines-windows-latest -D ./tmp-baselines-windows
   ```

5. **Visually review every new baseline** before committing. Check:
   - All expected UI elements are present
   - Layout and alignment are correct
   - No rendering artifacts or clipped content
   - Both Linux and Windows variants look consistent

6. **Copy reviewed baselines** to the snapshots directory:
   ```bash
   cp tmp-baselines-linux/09-visual-regression.spec.js-snapshots/<file>-linux.png e2e/tests/09-visual-regression.spec.js-snapshots/
   cp tmp-baselines-windows/09-visual-regression.spec.js-snapshots/<file>-win32.png e2e/tests/09-visual-regression.spec.js-snapshots/
   ```

7. **Revert the `--update-snapshots` flag** in `ci.yml`.

8. **Commit both** the new baselines and the reverted `ci.yml` in one commit. Clean up tmp directories.

9. **Push and verify** CI passes with the new baselines (no `--update-snapshots`).

## Do not

- Commit baselines without visual review
- Leave `--update-snapshots` in the CI config after baselines are committed
- Update only one platform (linux or win32) — both must match
