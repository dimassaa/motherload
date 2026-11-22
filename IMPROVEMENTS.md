# Improvements backlog — Motherload

Пока пусто. Некритичные находки добавляются сюда по мере работы.

## 2026-11-22, Task 1 — `sharp` high-severity advisory

`npm audit` reports one high-severity advisory in the `sharp` devDependency
(`<=0.35.5-rc.1`). It is used only by `scripts/build-og.js` (Task 3) to render
the static OG cover locally and is never loaded by the server, so it does not
affect the runtime image (`npm prune --omit=dev` in the Dockerfile). Deferred:
the approved dependency range is `sharp@^0.34`, and the fix requires an upgrade
decision that belongs to Task 24 (docs, CI, final polish).

## 2026-11-22, Task 3 — mobile navigation lacks a scroll affordance

On widths below 768 px the app navigation scrolls horizontally, and the only
hint is the clipped next item. A fade mask or chevron would make it obvious, but
a mask would also fade the first item on desktop and belongs with the visual
polish pass in Task 24. Deferred: not a functional defect, and the nav remains
fully keyboard- and touch-scrollable.
