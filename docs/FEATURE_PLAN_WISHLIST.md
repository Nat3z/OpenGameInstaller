# Feature Plan: Wishlist (“Save for later”)

## Summary

**One impactful feature:** A **Wishlist** that lets users save games from search and store pages to a list they can revisit later, then open the store page or start a download in one click.

- **Value:** Users can collect games they’re interested in without downloading immediately, and return to them from one place. Fits “discover → save → download later” without touching startup/splash or addon logic.
- **Integration:** Reuses `BasicLibraryInfo` (name, capsuleImage, appID, storefront), existing `fs` API for `./internals/`, and the same navigation pattern as Discover (open store via `currentStorePageOpened` + `currentStorePageOpenedStorefront`).
- **No conflict:** No changes to `startup-runner.ts`, `preload.mts` splash flow, migrations, or download persistence.
- **Scope:** Persist a single JSON list, add “Add/Remove from wishlist” in StorePage and search results, and show a Wishlist section in the Discover view. Implementable in a few hours to a day.

---

## 1. User stories

- As a user, I can **add a game to my wishlist** from the store page or from search results so I don’t have to search again later.
- As a user, I can **see my wishlist** in one place (Discover) and open any game’s store page from there.
- As a user, I can **remove a game from my wishlist** from the store page or from the wishlist section.
- As a user, my wishlist **persists** across app restarts (stored on disk like “recently played”).

---

## 2. Data model and storage

- **Shape:** One entry = `BasicLibraryInfo`: `{ name, capsuleImage, appID, storefront }`. Same as search/Discover, so opening the store page reuses existing logic.
- **File:** `./internals/wishlist.json`.
- **Format:** Array of entries, e.g. `BasicLibraryInfo[]`. Optional: dedupe by `(appID, storefront)` when adding.
- **Location:** Reuse existing `window.electronAPI.fs` (read/write/exists/mkdir). No new IPC or Electron handlers; same pattern as `internals/apps.json` and `internals/update-state.json`.

---

## 3. Frontend: wishlist state and helpers

- **New module (e.g. `application/src/frontend/lib/core/wishlist.ts`):**
  - `WISHLIST_PATH = './internals/wishlist.json'`.
  - `loadWishlist(): Promise<BasicLibraryInfo[]>` — ensure `./internals` exists, read JSON, return `[]` if missing/invalid.
  - `saveWishlist(entries: BasicLibraryInfo[]): void` — write JSON to `WISHLIST_PATH`.
  - `addToWishlist(entry: BasicLibraryInfo): void` — load, dedupe by `(appID, storefront)`, append, save.
  - `removeFromWishlist(appID: number, storefront: string): void` — load, filter out, save.
  - `isInWishlist(appID: number, storefront: string): boolean` — load and check (or expose a reactive store and keep it in sync).
- **Store (optional but recommended):** A Svelte writable store `wishlist: Writable<BasicLibraryInfo[]>` in `store.ts`, updated whenever wishlist is loaded or mutated, so the UI (StorePage, search results, Discover) can react without re-reading the file every time.

---

## 4. UI: Add / Remove on StorePage

- **StorePage.svelte** already has `appID`, `storefront`, and `gameData` (with name, capsuleImage). When not loading:
  - If `isInWishlist(appID, storefront)`: show a “Remove from wishlist” (or heart filled) button.
  - Else: show “Add to wishlist” (or heart outline).
  - On click: call `addToWishlist(...)` or `removeFromWishlist(...)`, then update the wishlist store so the button state and Discover section stay in sync.
- Use inline classes for the single button; match existing header/button style (e.g. `header-button`-like or existing StorePage actions).

---

## 5. UI: Add to wishlist from search results

- **App.svelte** (search results): each result has `result.appID`, `result.storefront`, `result.name`, `result.capsuleImage`. Add a small “Add to wishlist” (or heart) on each `search-result-item`:
  - If already in wishlist: show “Remove from wishlist” or filled heart.
  - On click: same add/remove + store update.
- Keeps search results and StorePage behavior consistent.

---

## 6. UI: Wishlist section in Discover

- **DiscoverView.svelte**:
  - On mount (or when wishlist store changes), load wishlist and display a **“Your wishlist”** section at the top (above addon catalogs).
  - Reuse the same card/carousel pattern as catalog sections: show capsule image, name, and a “View” (or “Open”) button that calls the same `openGameStorePage(game)` used for catalog items. Optionally a “Remove from wishlist” on the card.
  - If wishlist is empty, show a short message: “Games you add from search or store will appear here.”
- Opening a wishlist item: `currentStorePageOpened.set(game.appID)`, `currentStorePageOpenedStorefront.set(game.storefront)`, `viewOpenedWhenChanged.set($selectedView)` — same as existing `openGameStorePage` in DiscoverView.

---

## 7. Auto-remove from wishlist when installed (optional)

- When a game is added to the library (e.g. after setup completes), remove it from the wishlist by `(appID, storefront)` so the list doesn’t fill with already-installed games. This can be a small follow-up: in the code path that writes `./library/{appID}.json` or updates library state, call `removeFromWishlist(appID, storefront)` (and update the store). If time-boxed, this can be Phase 2.

---

## 8. File and code change list

| Area | File(s) | Change |
|------|---------|--------|
| Core logic | `src/frontend/lib/core/wishlist.ts` (new) | Load/save/add/remove wishlist, optional store |
| State | `src/frontend/store.ts` | Add `wishlist` writable store; optionally init from `loadWishlist()` in App or DiscoverView |
| Store page | `src/frontend/components/StorePage.svelte` | Add/remove wishlist button; sync store |
| Search results | `src/frontend/App.svelte` | Add/remove wishlist on each search result item |
| Discover | `src/frontend/views/DiscoverView.svelte` | “Your wishlist” section at top; open store or remove from list |

No changes to: `startup-runner.ts`, `preload.mts`, migrations, download persistence, or addon server.

---

## 9. Implementation order

1. **Wishlist module + store**  
   Create `wishlist.ts` with load/save/add/remove; add `wishlist` store and init on app load (e.g. in `App.svelte` onMount after other init).

2. **StorePage**  
   Add “Add to wishlist” / “Remove from wishlist” button; wire to wishlist module and store.

3. **DiscoverView**  
   Add “Your wishlist” section; load from store, render cards, open store page or remove.

4. **Search results in App.svelte**  
   Add wishlist action per result; keep StorePage and search UX consistent.

5. **(Optional)**  
   Remove from wishlist when game is installed (library write path).

---

## 10. Edge cases and notes

- **Deduplication:** Always dedupe by `(appID, storefront)` when adding so the same game from the same storefront appears once.
- **Missing images:** Wishlist entries store `capsuleImage` URL; if it goes 404, reuse existing fallback (e.g. `./favicon.png`) like in search results.
- **Offline:** Wishlist is local; no network needed to add/remove or view. Opening the store page will still require network when the user navigates.
- **Existing “recently played”:** Uses `internals/apps.json`; wishlist is separate and does not modify that file.

This plan keeps the feature contained, uses existing patterns (fs, BasicLibraryInfo, store navigation), and avoids overlapping with the current startup/splash refactor or other in-progress work.
