# Feature Improvement: Failed Setups Discoverability in Header

## Summary

**One impactful improvement:** Add a **Failed Setups** indicator in the app header (next to Downloads and Notifications) so users can see and act on failed installations without opening the Download tab.

---

## Why This Matters

- **Current behavior:** Failed setups (extraction or addon setup failures) are only visible in the **Download** view, in a "Failed Setups" section below active/paused downloads. Notifications are created for some failures, but there is no persistent, at-a-glance indicator.
- **Problem:** Users who are on Library, Discovery, or Config may never notice failed setups unless they open the Download tab. Notifications can be missed or dismissed, and the notification panel doesn’t emphasize “you have items that need retry.”
- **Impact:** Making failed-setup count visible in the header and clickable to jump to the Download view (and ideally to the Failed Setups block) improves discoverability and recovery, especially after long downloads or when the app was closed during a failure.

---

## Scope

- **In scope:** Header badge/count for failed setups; clicking it switches to the Download view; optional scroll/focus to the Failed Setups section.
- **Out of scope:** Changing retry/remove logic, adding new retry options, or modifying the failed-setup data model.

---

## Implementation Plan

### 1. Expose failed-setup count in the header (App.svelte)

**Location:** `application/src/frontend/App.svelte`

**Changes:**

1. **Derived store for failed-setup count**  
   - Add a derived store (or `$derived` in Svelte 5) from `failedSetups` that exposes `failedSetups.length` (or reuse `failedSetups` and use `$failedSetups.length` in the template).  
   - Ensure `failedSetups` is imported from `./store` in `App.svelte` (it is not currently; add it).

2. **Header button and badge**  
   - In the right-side action buttons (where Downloads and Notifications are), add a third button: **Failed Setups**.
   - **Visual:** Reuse the same pattern as the Downloads button: icon + optional badge. Use a distinct but consistent icon (e.g. warning/exclamation or “alert” style) so it’s clear it’s about problems.
   - **Badge:** Show a numeric badge when `$failedSetups.length > 0`, same styling as the download/notification badges (e.g. `absolute -bottom-1 -right-1`, small circle with count).
   - **Click behavior:** Call `setView('downloader')` so the main content switches to the Download view. Optionally set a small flag or store value so the Download view can scroll to or focus the Failed Setups section (see step 3).
   - **Accessibility:** `aria-label` e.g. “Failed setups (N)” and optionally “Go to downloads to retry”.

**Files to edit:**

- `application/src/frontend/App.svelte`
  - Import `failedSetups` from `./store`.
  - In the header, add the Failed Setups button with icon, badge, and `onclick` that calls `setView('downloader')` (and optionally triggers scroll-to-section).

---

### 2. Optional: Scroll / focus to Failed Setups when opened from header

**Location:** `application/src/frontend/views/DownloadView.svelte` and optionally `application/src/frontend/store.ts` (or a tiny store in App).

**Option A – Query param or store flag (recommended):**

- Add a writable store, e.g. `focusFailedSetups: Writable<boolean> = writable(false)` in `store.ts`.
- When the user clicks the Failed Setups header button in `App.svelte`, after `setView('downloader')`, set `focusFailedSetups.set(true)`.
- In `DownloadView.svelte`, use `onMount` or `$effect` to subscribe to `focusFailedSetups`. When it becomes `true`, query for the Failed Setups section (e.g. a wrapper with `data-section="failed-setups"` or an id), call `element.scrollIntoView({ behavior: 'smooth', block: 'start' })`, then set `focusFailedSetups.set(false)` so it doesn’t re-run every time.

**Option B – Event:**

- In `App.svelte`, after `setView('downloader')`, dispatch a custom event, e.g. `document.dispatchEvent(new CustomEvent('download-view:focus-failed-setups'))`.
- In `DownloadView.svelte`, add a listener for that event and scroll to the Failed Setups block; remove listener on destroy.

**Files to edit:**

- `application/src/frontend/store.ts` – add `focusFailedSetups` (if using Option A).
- `application/src/frontend/App.svelte` – set flag or dispatch event when Failed Setups header button is clicked.
- `application/src/frontend/views/DownloadView.svelte` – add `data-section="failed-setups"` (or id) on the Failed Setups container; subscribe to flag or event and scroll into view.

---

### 3. Ensure failedSetups is loaded before header renders

**Current behavior:** `loadFailedSetups()` is called in `DownloadView.svelte`’s `onMount`, so failed setups are only loaded when the user opens the Download tab. If the header shows a count before that, it would show 0 until the user visits the tab once.

**Change:** Load failed setups at app startup so the header count is correct as soon as the app is ready.

- In `App.svelte`, inside the existing `onMount` (where you already call `fetchAddonsWithConfigure()`, `initDownloadPersistence()`, etc.), call `loadFailedSetups()` from `./lib/recovery/failedSetups` (or re-export from `utils` and call from there). That way `failedSetups` is populated early and the header badge is accurate even if the user never opened the Download tab before.

**Files to edit:**

- `application/src/frontend/App.svelte` – import `loadFailedSetups` (e.g. from `./utils` or directly from `./lib/recovery/failedSetups`) and call it in `onMount` alongside other init (e.g. after `initDownloadPersistence()`).
- `application/src/frontend/views/DownloadView.svelte` – you can keep the existing `loadFailedSetups()` in `onMount` for refresh when the user opens the tab, or remove it to avoid duplicate work; calling it twice is harmless.

---

### 4. UI/UX details

- **Icon:** Use an existing SVG in the codebase or add a small warning/alert icon (e.g. exclamation in a triangle or circle) so it’s visually distinct from the download and bell icons. Prefer the same size and style as the other header icons (`--header-button-size`, `--header-button-svg-size`).
- **Placement:** Place the Failed Setups button between **Downloads** and **Notifications** (or after Notifications), and keep the same spacing and alignment as the other header buttons.
- **Empty state:** When `$failedSetups.length === 0`, either hide the button or show the button without a badge. Hiding can reduce clutter but might make the button “jump” when the first failure appears; showing without a badge keeps layout stable and reminds users the feature exists. **Recommendation:** Always show the button; show the badge only when `$failedSetups.length > 0`.
- **Copy:** Aria-label and tooltip (if you add one) could be: “Failed setups” and “View and retry failed installations”.

---

### 5. Testing checklist

- [ ] With 0 failed setups: header shows Failed Setups button without a badge (or button hidden if you chose that).
- [ ] With 1+ failed setups: badge shows the correct count.
- [ ] Clicking the header button switches the main view to Download.
- [ ] Optional: After clicking, the Failed Setups section is scrolled into view in DownloadView.
- [ ] After retrying and removing all failed setups, the badge disappears (and optionally the count updates without reopening the tab, since `failedSetups` is in the store).
- [ ] After app restart, `loadFailedSetups()` runs on init and the header count is correct before the user opens the Download tab.
- [ ] Accessibility: keyboard focus and screen reader (aria-label) work for the new button.

---

### 6. File change summary

| File | Change |
|------|--------|
| `application/src/frontend/App.svelte` | Import `failedSetups`, `loadFailedSetups`; call `loadFailedSetups()` in onMount; add Failed Setups header button with icon + conditional badge; onclick → `setView('downloader')` and set scroll/focus flag or dispatch event. |
| `application/src/frontend/store.ts` | (Optional) Add `focusFailedSetups` writable. |
| `application/src/frontend/views/DownloadView.svelte` | (Optional) Add `data-section="failed-setups"` (or id) on Failed Setups container; subscribe to `focusFailedSetups` or event and scroll into view; reset flag after scroll. |

---

### 7. Effort estimate

- **Minimal (badge + navigate):** ~1–2 hours (imports, one button in header, init load).
- **With scroll-to-section:** +~30–60 minutes (store or event + scroll logic in DownloadView).

This keeps the change localized to the frontend, reuses existing stores and patterns, and does not touch addon or backend logic.
