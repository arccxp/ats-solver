"""Choice questions: single choice (baseline), select-all with checkboxes, true/false as two radios."""
import pytest

import fixtures as fx
from conftest import solve_to_hud, state

DONE = r"answered \d+/\d+"


def test_mcq_baseline_clicks_the_scripted_option(open_env):
    html = fx.attempt_html([fx.mcq(1, "What is 2 + 2 here?", ["3", "4", "5", "6"])])
    env = open_env(html, script=[{"reply": {"index": 1, "letter": "B"}}])
    assert env.call("do-ping")["kind"] == "mcq"
    assert solve_to_hud(env, DONE)["handled"] is True
    assert state(env) == [{"checked": [1], "values": [], "editor": None}]
    ask = env.asks()[0]["payload"]
    assert ask["kind"] == "mcq" and ask["multi"] is False
    assert [o["text"] for o in ask["options"]] == ["3", "4", "5", "6"]
    assert ask["stem"] == "What is 2 + 2 here?"


# ----------------------------------------------------------------- select all

def test_select_all_is_detected_as_multi(open_env):
    html = fx.attempt_html([fx.select_all(1, "Which of these are prime numbers?", ["2", "4", "5", "9"])])
    env = open_env(html)
    assert env.call("do-ping")["kind"] == "multi"
    assert env.call("do-where")["where"] == "attempt"


def test_select_all_checks_exactly_the_returned_indices(open_env):
    html = fx.attempt_html([fx.select_all(1, "Which of these are prime numbers?", ["2", "4", "5", "9"])])
    env = open_env(html, script=[{"reply": {"indices": [0, 2], "why": "prime"}}])
    assert env.call("do-solve")["kind"] == "mixed"
    env.wait_hud(DONE)
    assert state(env)[0]["checked"] == [0, 2]
    p = env.asks()[0]["payload"]
    assert p["kind"] == "mcq" and p["multi"] is True
    assert [o["text"] for o in p["options"]] == ["2", "4", "5", "9"]
    assert p["stem"] == "Which of these are prime numbers?"


def test_select_all_unchecks_a_preselected_wrong_option(open_env):
    """Only reached when nothing is ticked yet (an answered question is skipped); so tick one by hand, then
    confirm the question counts as answered and is NOT re-asked or changed."""
    html = fx.attempt_html([fx.select_all(1, "Pick the primes please", ["2", "4", "5", "9"])])
    env = open_env(html, script=[{"reply": {"indices": [0, 2]}}])
    env.page.check("input[type=checkbox] >> nth=1")
    env.call("do-solve")
    env.wait_hud(DONE)
    assert state(env)[0]["checked"] == [1]
    assert env.asks() == []


def test_select_all_with_no_indices_is_an_error_and_clicks_nothing(open_env):
    html = fx.attempt_html([fx.select_all(1, "Pick the primes please", ["2", "4", "5", "9"])])
    env = open_env(html, script=[{"reply": {"indices": []}}])
    env.call("do-solve")
    env.wait_hud(r"no choice picked")
    assert state(env)[0]["checked"] == []
    assert env.ev().count("submit-click") == 0


def test_select_all_single_correct_answer(open_env):
    html = fx.attempt_html([fx.select_all(1, "Which one is a vowel?", ["b", "e", "k"])])
    env = open_env(html, script=[{"reply": {"indices": [1]}}])
    env.call("do-solve")
    env.wait_hud(DONE)
    assert state(env)[0]["checked"] == [1]


# ----------------------------------------------------------------- true / false

@pytest.mark.parametrize("rich", [True, False], ids=["quill-options", "plain-text-options"])
@pytest.mark.parametrize("answer,idx", [("True", 0), ("False", 1)])
def test_true_false_two_radios(open_env, rich, answer, idx):
    html = fx.attempt_html([fx.true_false(1, "The Earth orbits the Sun.", rich=rich)])
    env = open_env(html, script=[{"reply": {"pick": answer}}])
    assert env.call("do-ping")["kind"] == "mcq"
    env.call("do-solve")
    env.wait_hud(DONE)
    assert state(env)[0]["checked"] == [idx]
    p = env.asks()[0]["payload"]
    assert [o["text"] for o in p["options"]] == ["True", "False"]


def test_true_false_short_stem_still_gets_asked(open_env):
    """A stem under 8 characters asks for a screenshot; the mock capture returns nothing and the run goes on."""
    html = fx.attempt_html([fx.true_false(1, "2>1?")])
    env = open_env(html, script=[{"reply": {"pick": "True"}}])
    env.call("do-solve")
    env.wait_hud(DONE)
    assert state(env)[0]["checked"] == [0]
    assert env.asks()[0]["payload"]["image"] is None


def test_mixed_page_all_kinds_answered_in_order(open_env):
    qs = [
        fx.mcq(1, "Pick the second letter", ["a", "b", "c"]),
        fx.select_all(2, "Pick all the vowels here", ["a", "b", "e"]),
        fx.true_false(3, "Water is wet at room temperature"),
    ]
    env = open_env(
        fx.attempt_html(qs),
        script=[
            {"match": "second letter", "reply": {"index": 1}},
            {"match": "vowels", "reply": {"indices": [0, 2]}},
            {"match": "Water", "reply": {"pick": "True"}},
        ],
    )
    assert env.call("do-ping")["kind"] == "mcq,multi,mcq"
    env.call("do-solve")
    env.wait_hud(r"answered 3/3")
    assert [s["checked"] for s in state(env)] == [[1], [0, 2], [0]]
