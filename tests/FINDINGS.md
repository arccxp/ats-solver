# ats.js test findings

Offline suite in `tests/` (Playwright + pytest, own headless chromium, the real site is never contacted).
Run: `cd tests && python3 -m pytest -q -rx`. Run it against another build with `ATS_JS=/path/to/copy.js python3 -m pytest`.
`--runxfail` shows the raw failure of a known bug.

**Build under test:** `ats.js` sha256 `240e856050ef…`, 736 lines (the build after `main` applied the reviewer's fixes).
`ats.js` changed while the suite was being written (684 lines -> 733 -> 736). Where a result comes from the older build it says so.

**Result on that build: 64 passed, 1 xfailed (BUG-2, strict), 0 failed** (`python3 -m pytest -q -rx`, 196 s).

## What is real and what is modelled

Only multiple choice (radio) markup was captured from the live site. Everything else in `fixtures.py` is built from that markup
plus Blackboard conventions: MUI checkbox in `role="group"`, plain `<input type=text>` for short answer / blanks, a Quill editor
with `contenteditable="true"` for essays, a `role="dialog"` with Cancel/Submit (text and classes from the DOM notes), a Start link
`<a href="javascript:void(0)">Start attempt</a>` with an optional Begin/Cancel dialog. A failure that depends on one of those
guesses is called out as such.

## Scenario status

| Scenario | Tests | Status on current build |
| --- | --- | --- |
| Single-choice baseline (radio, verified markup) | `test_choices.py` | pass |
| Select all that apply (checkboxes, `role=group`) | `test_choices.py` | pass: exactly the returned indices are ticked, empty reply is an error, a ticked question is not re-asked |
| True/false as 2 radios (Quill options and plain-text options) | `test_choices.py` | pass |
| Short answer (1 input) | `test_text.py` | pass: typed through the native setter, `input`/`change` fire, a filled box is left alone |
| Fill in the blank (N inputs) | `test_text.py` | pass; fewer/more answers than blanks is refused (BUG-1, fixed) |
| Essay (`contenteditable`) | `test_text.py` | pass: never asked, never typed into, Submit not pressed (also with `autoSubmit` on, with other questions answered, and in `do-run-assessment`) |
| Paged mode (one question per page, Next) | `test_paged.py` | pass: all pages answered in order, Next disabled/hidden on the last page ends the walk, slow repaint, Next that does nothing, essay on page 2 blocks Submit |
| Submit flow (dialog Cancel/Submit, list removed) | `test_submit.py` | pass except BUG-2 (xfail) |
| Overview skip logic (Respondus, proctored, `0 attempts left`, `Start attempt 2`, unrelated links) | `test_overview.py` | pass |
| Start flow (Start link -> Begin/Cancel dialog -> attempt) | `test_overview.py` | pass: Begin pressed, Cancel never, full order checked; dialog naming Respondus/proctoring is not confirmed |
| Course run: assignment, past-due, non-assessment columns, empty queue | `test_overview.py` | pass (REST calls served from canned JSON, page reloads between steps) |
| Run ownership (a run owned by another tab is ignored) | `test_overview.py` | pass |

## Bugs proven

### BUG-1: fewer answers than blanks was accepted and the attempt handed in with a blank — FIXED in the current build

- Test: `test_text.py::test_fill_with_fewer_words_than_blanks_is_not_submitted`.
- Observed on the 684-line build: the test failed (reply `words: ["red","green"]` for 3 blanks, `mismatch: "model gave 2, page has 3"`),
  blank 3 stayed empty and Submit was pressed.
  (I saw this as an expected-failure run before `main`'s edit landed; I did not keep a copy of that build, so it cannot be re-run
  byte for byte.)
- Root cause: `askOther` ignored `ans.mismatch` (`background.js` `parseCloze` sets it when the counts differ) and `apply` skipped a
  blank when `r.words[i] == null`, so the question still counted as answered.
- Fix now in `ats.js` (`askOther`, the `ans.mismatch` and `ans.words.length !== blanks` checks). Confirmed the test detects the
  regression: with both checks removed from a scratch copy the test fails (and the page ends up with the literal text `undefined`
  in blank 3, because `apply` no longer skips a missing word).

### BUG-2: Submit is checked once, right after the last answer; if the site has not enabled it yet the run gives up — OPEN

- Test: `test_submit.py::test_submit_enabled_only_after_autosave_lag` (marked `xfail`, strict).
- Failure: `AssertionError: Submit was disabled when checked and the run never retried`; events are only `['page:0','answer:radio']`.
  With `autoSubmit` on, or in an auto run, the answers are in but the attempt is left open and unsubmitted (`do-run-*` then
  reports `stopped: not submitted` and halts).
- Root cause (`solve`, after the pages are answered):
  `const submitBtn = await until(() => scrape().submit, 8000);` returns the button even while it is `disabled`, and the next line tests
  `!submitBtn.disabled` once.
- Assumption to confirm: the fixture enables Submit 700 ms after the last answer, imitating Ultra's autosave. Real evidence is only that the
  saved attempt page (no answers yet) had Submit `disabled` with class `disabled`. How long the real site takes to enable it after an
  answer was not measured. If it is instant the bug does not show on the live site, but waiting costs nothing.
- Minimal patch (verified: with it applied to a scratch copy all 11 tests in `test_submit.py` pass under `--runxfail`):

```diff
-      const submitBtn = await until(() => scrape().submit, 8000);
-      if ((CFG.autoSubmit || opts.forceSubmit) && submitBtn && !submitBtn.disabled) {
+      // The site enables Submit only once its autosave has caught up with the last answer.
+      const submitBtn = await until(() => { const b = scrape().submit; return b && !b.disabled ? b : null; }, 8000);
+      if ((CFG.autoSubmit || opts.forceSubmit) && submitBtn) {
```

## Reviewer items covered by tests (all pass on the current build)

Each test was also run against a scratch copy of `ats.js` with that one fix reverted, and fails there, so it does guard the fix.

| Reviewer item | Test | Reverted fix makes it fail |
| --- | --- | --- |
| 1 Next-click race (paged) | `test_paged.py::test_slow_page_render_does_not_double_answer_or_skip_a_page`, `::test_page_that_never_changes_stops_instead_of_looping` | yes (both) |
| 2 No "nothing left" gate before Submit | `test_submit.py::test_unanswered_placeholder_li_blocks_submit` | yes |
| 3 Wrong blank count accepted | `test_text.py::test_fill_with_fewer_words_than_blanks_is_not_submitted` | yes (needs both guards removed) |
| 5 Run picked up by any tab | `test_overview.py::test_run_started_in_another_tab_is_not_picked_up` | yes |
| 6 Attempt used before questions render | `test_submit.py::test_run_waits_for_questions_that_render_late` | yes |
| 8 Retaking a handed-in test (`Start attempt 2`) | `test_overview.py::test_start_attempt_two_means_an_earlier_attempt_was_handed_in` | yes |
| 10 List blinking out counted as submitted | `test_submit.py::test_list_that_blinks_out_is_not_counted_as_submitted` | yes |
| 11 Start match too broad | `test_overview.py::test_unrelated_links_are_not_mistaken_for_start` (`Start date`, `Continue to course`, `Begin`) | yes |
| Start dialog naming Respondus/proctoring | `test_overview.py::test_start_dialog_that_mentions_respondus_or_proctoring_is_not_confirmed` | yes |

For the items where I could only test the fixed build I cannot say the old build failed these tests, only that the tests
fail when the fix is taken out.

## Looked at and not a bug

- Select-all indices outside the option list, and a whitespace-only short answer: `ats.js` would accept them, but
  `background.js` (`parseMulti` checks `okIndex`; `parseCloze` trims and drops empty words) never produces them, so there is no
  way to reach it through the real message contract. Not tested.
- Closing a dialog by hiding it (`display:none`) rather than removing it: not re-clicked (`visible()` filters it). Covered by every dialog test.
- `Save and Close` is never clicked (asserted in the Submit test).

## Not covered / limits

- Fixtures guess the DOM for checkbox, short, blank, essay, paged and the Start dialog. Verify against the live site before trusting a pass.
- The mock keeps `chrome.storage` in `sessionStorage`, so it is per tab; cross-tab behaviour is only tested by seeding a run that another tab owns.
- Not tested: images/screenshots, voting on doubtful answers, matching/ordering/dropdown questions (left alone by design), the popup,
  the stop hotkey, reviewer items 4, 7, 9, 12-15.
- Mutation runs used the unchanged `ats.js` with one fix edited out in a scratch copy; none touched the project file.
