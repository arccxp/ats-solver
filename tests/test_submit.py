"""The Submit flow: footer Submit -> role=dialog (Cancel / Submit) -> affirmative button -> ol.attempt-question-list gone."""
import pytest

import fixtures as fx
from conftest import state

QS = lambda: [fx.mcq(1, "Pick the second letter", ["a", "b", "c"])]
SCRIPT = [{"reply": {"index": 1}}]


def test_submit_dialog_is_confirmed_with_submit_not_cancel(open_env):
    env = open_env(fx.attempt_html(QS()), script=SCRIPT, store={"autoSubmit": True})
    env.call("do-solve")
    env.wait("window.__ev.includes('list-removed')")
    ev = env.ev()
    assert ev == [e for e in ev if e != "dialog-btn:Cancel"], "Cancel was pressed"
    assert ev.index("submit-click") < ev.index("dialog:Submit Test?") < ev.index("dialog-btn:Submit") < ev.index("list-removed")
    assert ev.count("dialog-btn:Submit") == 1 and "save-click" not in ev
    assert env.page.query_selector("ol.attempt-question-list") is None
    env.wait_hud(r"answered 1 and submitted")


def test_submit_without_autosubmit_never_touches_the_button(open_env):
    env = open_env(fx.attempt_html(QS(), enable="always"), script=SCRIPT)
    env.call("do-solve")
    env.wait_hud(r"answered 1/1")
    env.settle(2500)
    assert "submit-click" not in env.ev()
    assert env.page.query_selector("ol.attempt-question-list") is not None


def test_site_that_submits_without_a_dialog(open_env):
    env = open_env(fx.attempt_html(QS(), submit="direct"), script=SCRIPT, store={"autoSubmit": True})
    env.call("do-solve")
    env.wait("window.__ev.includes('list-removed')")
    env.wait_hud(r"and submitted")
    assert not any(e.startswith("dialog") for e in env.ev())


def test_slow_confirmation_is_waited_for(open_env):
    env = open_env(fx.attempt_html(QS(), submit_delay=4000), script=SCRIPT, store={"autoSubmit": True})
    env.call("do-solve")
    env.wait_hud(r"and submitted", timeout=30000)
    assert env.ev().count("submit-click") == 1


def test_attempt_that_stays_open_after_confirming_is_reported(open_env):
    """If the list never goes away the run must say so, not claim success."""
    env = open_env(fx.attempt_html(QS(), submit_delay=10 ** 7), script=SCRIPT, store={"autoSubmit": True})
    env.call("do-solve")
    env.wait_hud(r"still open", timeout=40000)
    assert "list-removed" not in env.ev()


def test_list_that_blinks_out_is_not_counted_as_submitted(open_env):
    env = open_env(fx.attempt_html(QS(), blink=600), script=SCRIPT, store={"autoSubmit": True})
    env.call("do-solve")
    env.wait_hud(r"still open", timeout=30000)
    assert "list-blink" in env.ev() and "list-removed" not in env.ev()


def test_stop_before_submit_keeps_submit_unpressed(open_env):
    env = open_env(fx.attempt_html(QS(), enable="always"), script=[{"reply": {"index": 1}, "delay": 1500}], store={"autoSubmit": True})
    env.call("do-solve")
    env.page.wait_for_timeout(300)
    assert env.call("do-stop") == {"stopping": True}
    env.settle(3500)
    assert "submit-click" not in env.ev()
    assert state(env)[0]["checked"] == []


def test_run_assessment_on_an_open_attempt_answers_and_submits(open_env):
    env = open_env(fx.attempt_html(QS()), script=SCRIPT)
    assert env.call("do-run-assessment")["handled"] is True
    run = env.run_finished()
    assert run["solved"] == 1 and run["skipped"] == []
    assert env.page.query_selector("ol.attempt-question-list") is None
    assert env.ev().count("dialog-btn:Submit") == 1


@pytest.mark.bug
def test_submit_enabled_only_after_autosave_lag(open_env):
    """The live page's Submit was disabled while nothing was answered. Model the site enabling it 700 ms
    after the last answer (autosave) and require that the run waits for it instead of giving up.

    BUG-2, fixed in ats.js: the wait is on an enabled button, not on the button existing.
    """
    env = open_env(fx.attempt_html(QS(), enable="lag", lag=700), script=SCRIPT, store={"autoSubmit": True})
    env.call("do-solve")
    env.settle(6000)
    assert "submit-click" in env.ev(), "Submit was disabled when checked and the run never retried"


# ------------------------------------------------------------ nothing-left gate

def test_unanswered_placeholder_li_blocks_submit(open_env):
    """An li that has no .assessment-question (lazy render) is invisible to scrape(); the site's own
    'N of M questions remaining' counter must stop the hand-in."""
    placeholder = '<li class="lazy"><div class="loading">Loading question…</div></li>'
    env = open_env(fx.attempt_html([fx.mcq(1, "Pick the second letter", ["a", "b", "c"]), placeholder], enable="always"),
                   script=SCRIPT, store={"autoSubmit": True})
    env.call("do-solve")
    env.wait_hud(r"still unanswered")
    env.settle(2000)
    assert "submit-click" not in env.ev()


def test_run_waits_for_questions_that_render_late(open_env):
    """After a reload or Start, the list exists before its questions do."""
    env = open_env(fx.attempt_html(QS(), render_delay=2500), url=fx.attempt_url(), script=SCRIPT, store={"autoSubmit": False})
    assert env.call("do-run-assessment")["handled"] is True
    run = env.run_finished(timeout=60000)
    assert run["solved"] == 1, run


def test_late_attempt_submit_late_button_is_pressed_and_confirmed(open_env):
    env = open_env(fx.attempt_html(QS(), submit_label="Submit Late"), script=SCRIPT, store={"autoSubmit": True})
    env.call("do-solve")
    env.wait("window.__ev.includes('list-removed')")
    ev = env.ev()
    assert "dialog-btn:Cancel" not in ev and "save-click" not in ev
    assert ev.index("submit-click") < ev.index("dialog-btn:Submit Late") < ev.index("list-removed")
    env.wait_hud(r"answered 1 and submitted")
