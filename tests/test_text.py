"""Short answer (one text input), fill-in-the-blank (several inputs) and essay (contenteditable)."""
import pytest

import fixtures as fx
from conftest import state

DONE = r"answered \d+/\d+"


def test_short_answer_is_detected_and_typed(open_env):
    html = fx.attempt_html([fx.short_answer(1, "What is the capital of France?")])
    env = open_env(html, script=[{"reply": {"words": ["Paris"], "why": "capital"}}])
    assert env.call("do-ping")["kind"] == "short"
    env.call("do-solve")
    env.wait_hud(DONE)
    assert state(env)[0]["values"] == ["Paris"]
    p = env.asks()[0]["payload"]
    assert p["kind"] == "cloze"
    assert p["cloze"] == {"text": "What is the capital of France? [blank 1]", "blanks": [{}], "wordBank": []}
    assert p["stem"] == "What is the capital of France?"


def test_short_answer_fires_input_and_change_events(open_env):
    """The page autosaves from input/change events, so a bare .value assignment would not count."""
    html = fx.attempt_html([fx.short_answer(1, "What is the capital of France?")])
    env = open_env(html, script=[{"reply": {"words": ["Paris"]}}])
    env.call("do-solve")
    env.wait_hud(DONE)
    assert "answer:text" in env.ev()


def test_short_answer_already_filled_is_left_alone(open_env):
    html = fx.attempt_html([fx.short_answer(1, "What is the capital of France?")])
    env = open_env(html, script=[{"reply": {"words": ["Lyon"]}}])
    env.page.fill("input[type=text]", "Paris")
    env.call("do-solve")
    env.wait_hud(DONE)
    assert state(env)[0]["values"] == ["Paris"]
    assert env.asks() == []


def test_fill_in_the_blank_types_each_blank_in_order(open_env):
    html = fx.attempt_html([fx.fill_blank(1, "The capital of ___ is ___ and its river is the ___.", 3)])
    env = open_env(html, script=[{"reply": {"words": ["France", "Paris", "Seine"]}}])
    assert env.call("do-ping")["kind"] == "fill"
    env.call("do-solve")
    env.wait_hud(DONE)
    assert state(env)[0]["values"] == ["France", "Paris", "Seine"]
    p = env.asks()[0]["payload"]
    assert p["kind"] == "cloze" and len(p["cloze"]["blanks"]) == 3
    assert p["stem"].endswith("(3 blanks)")


def test_fill_in_the_blank_sends_the_stem_text_but_not_the_blank_labels(open_env):
    html = fx.attempt_html([fx.fill_blank(1, "Complete the sentence about water.", 2)])
    env = open_env(html, script=[{"reply": {"words": ["a", "b"]}}])
    env.call("do-solve")
    env.wait_hud(DONE)
    stem = env.asks()[0]["payload"]["stem"]
    assert "Complete the sentence about water." in stem
    assert "Blank 1" not in stem and "Question 1" not in stem and "Points" not in stem


def test_text_questions_are_submitted_after_the_dialog(open_env):
    qs = [fx.short_answer(1, "What is the capital of France?"), fx.fill_blank(2, "Fill: ___ and ___ here.", 2)]
    env = open_env(
        fx.attempt_html(qs),
        script=[{"match": "France", "reply": {"words": ["Paris"]}}, {"match": "Fill", "reply": {"words": ["x", "y"]}}],
        store={"autoSubmit": True},
    )
    env.call("do-solve")
    env.wait("window.__ev.includes('list-removed')")
    assert env.ev().index("dialog:Submit Test?") < env.ev().index("dialog-btn:Submit")


def test_model_error_stops_before_submit(open_env):
    html = fx.attempt_html([fx.short_answer(1, "What is the capital of France?")], enable="always")
    env = open_env(html, script=[{"reply": {"error": "model refused"}}], store={"autoSubmit": True})
    env.call("do-solve")
    env.wait_hud(r"model refused")
    env.settle()
    assert state(env)[0]["values"] == [""]
    assert "submit-click" not in env.ev()


def test_fill_with_fewer_words_than_blanks_is_not_submitted(open_env):
    """background.parseCloze returns {words, mismatch: 'model gave 2, page has 3'} for this; ats.js ignores `mismatch`."""
    html = fx.attempt_html([fx.fill_blank(1, "Name three colours: ___, ___, ___.", 3)], enable="always")
    env = open_env(
        html,
        script=[{"reply": {"words": ["red", "green"], "mismatch": "model gave 2, page has 3"}}],
        store={"autoSubmit": True},
    )
    env.call("do-solve")
    env.settle(3000)
    assert state(env)[0]["values"][2] == ""
    assert "submit-click" not in env.ev(), "submitted with blank 3 empty"


# ---------------------------------------------------------------------- essay

def test_essay_is_other_and_never_asked(open_env):
    html = fx.attempt_html([fx.essay(1, "Discuss the causes of the war in 300 words.")], enable="always")
    env = open_env(html, script=[{"reply": {"words": ["should never be typed"]}}], store={"autoSubmit": True})
    assert env.call("do-ping")["kind"] == "other"
    env.call("do-solve")
    env.wait_hud(r"not submitting")
    env.settle()
    assert env.asks() == []
    assert state(env)[0]["editor"] == "" or state(env)[0]["editor"] is None
    assert "submit-click" not in env.ev()
    assert "essay" in env.hud()


def test_essay_with_autosubmit_on_does_not_press_submit_even_after_other_answers(open_env):
    qs = [fx.mcq(1, "Pick the second letter", ["a", "b", "c"]), fx.essay(2, "Explain your answer in detail.")]
    env = open_env(fx.attempt_html(qs, enable="always"), script=[{"reply": {"index": 1}}], store={"autoSubmit": True})
    env.call("do-solve")
    env.wait_hud(r"left 1 that cannot be answered")
    env.settle(2500)
    s = state(env)
    assert s[0]["checked"] == [1]
    assert s[1]["editor"] in ("", None)
    assert "submit-click" not in env.ev()
    assert len(env.asks()) == 1


def test_essay_run_assessment_halts_and_leaves_attempt_open(open_env):
    qs = [fx.mcq(1, "Pick the second letter", ["a", "b", "c"]), fx.essay(2, "Explain your answer in detail.")]
    env = open_env(fx.attempt_html(qs, enable="always"), script=[{"reply": {"index": 1}}])
    assert env.call("do-run-assessment")["handled"] is True
    run = env.run_finished()
    assert run["solved"] == 0
    assert any("essay" in s["why"] for s in run["skipped"]), run["skipped"]
    assert "submit-click" not in env.ev()
    assert env.page.query_selector("ol.attempt-question-list") is not None


def test_essay_only_page_reports_zero_done(open_env):
    env = open_env(fx.attempt_html([fx.essay(1, "Write an essay about anything.")], enable="always"), store={"autoSubmit": True})
    env.call("do-solve")
    env.wait_hud(r"answered 0 of 1")
    env.settle()
    assert "submit-click" not in env.ev()


def test_essay_editor_with_contenteditable_is_not_mistaken_for_text_input(open_env):
    """The editor's hidden .ql-clipboard is contenteditable too; it must not turn an essay into a text question."""
    env = open_env(fx.attempt_html([fx.essay(1, "Write an essay about anything.")]))
    assert env.call("do-ping")["kind"] == "other"


def _one_short(**kw):
    return fx.attempt_html([fx.short_answer(1, "What is the capital of France?")], enable="always", **kw)


def test_rate_limit_is_waited_out_and_the_question_answered(open_env):
    env = open_env(
        _one_short(),
        script=[{"reply": {"error": "empty reply (finish_reason=rate_limit_reached)"}, "times": 2},
                {"match": "France", "reply": {"words": ["Paris"]}}],
        store={"rateWait": 100},
    )
    env.call("do-solve")
    env.wait_hud(r"answered 1/1", timeout=20000)
    assert state(env)[0]["values"] == ["Paris"]
    assert len(env.asks()) == 3


def test_rate_limit_that_never_clears_stops_without_submitting(open_env):
    env = open_env(
        _one_short(),
        script=[{"reply": {"error": "rate_limit_reached"}}],
        store={"rateWait": 50, "autoSubmit": True},
    )
    env.call("do-solve")
    env.wait_hud(r"rate_limit_reached", timeout=20000)
    env.settle()
    assert state(env)[0]["values"] == [""]
    assert "submit-click" not in env.ev()
    assert len(env.asks()) == 4          # the first try and three waits


def test_worker_that_is_not_listening_yet_is_retried(open_env):
    env = open_env(
        _one_short(),
        script=[{"throw": "Could not establish connection. Receiving end does not exist.", "times": 2},
                {"match": "France", "reply": {"words": ["Paris"]}}],
    )
    env.call("do-solve")
    env.wait_hud(r"answered 1/1", timeout=30000)
    assert state(env)[0]["values"] == ["Paris"]


def test_chat_site_hiccup_sentence_is_asked_again(open_env):
    env = open_env(
        _one_short(),
        script=[{"reply": {"error": 'unparseable reply "Sorry, something went wrong. Please try your request again."'}, "times": 1},
                {"match": "France", "reply": {"words": ["Paris"]}}],
        store={"rateWait": 100},
    )
    env.call("do-solve")
    env.wait_hud(r"answered 1/1", timeout=20000)
    assert state(env)[0]["values"] == ["Paris"]
    assert len(env.asks()) == 2


def test_questions_still_queued_are_not_sent_after_the_run_has_failed(open_env):
    qs = [fx.short_answer(i, f"Question {i} about capitals?") for i in (1, 2, 3)]
    env = open_env(fx.attempt_html(qs, enable="always"), script=[{"reply": {"error": "model refused"}}],
                   store={"concurrency": 1})
    env.call("do-solve")
    env.wait_hud(r"model refused")
    env.settle(1500)
    assert len(env.asks()) == 1


def test_answered_attempt_with_no_usable_submit_button_says_so(open_env):
    html = fx.attempt_html([fx.short_answer(1, "What is the capital of France?")], enable="change")
    env = open_env(html, script=[{"reply": {"words": ["Paris"]}}], store={"autoSubmit": True})
    env.page.evaluate("document.getElementById('submit-btn').remove()")
    env.call("do-solve")
    env.wait_hud(r"Submit button was not found", timeout=20000)
    assert "submit-click" not in env.ev()


def test_retry_message_shows_the_models_reason_and_does_not_claim_a_rate_limit(open_env):
    env = open_env(
        _one_short(),
        script=[{"reply": {"error": "empty reply (finish_reason=rate_limit_reached)"}, "times": 1},
                {"match": "France", "reply": {"words": ["Paris"]}}],
        store={"rateWait": 3000},
    )
    env.call("do-solve")
    env.wait_hud(r"did not answer \(empty reply \(finish_reason=rate_limit_reached\)\)", timeout=10000)
    assert "rate limited" not in env.hud().lower()
    env.wait_hud(r"answered 1/1", timeout=20000)
