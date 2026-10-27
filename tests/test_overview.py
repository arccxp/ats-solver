"""Overview pages: which ones a run must not open, and the Start flow (Start link -> Begin/Cancel dialog -> attempt)."""
import pytest

import fixtures as fx
from conftest import state

QS = lambda: [fx.mcq(1, "Pick the second letter", ["a", "b", "c"])]
SCRIPT = [{"reply": {"index": 1}}]
OV = fx.overview_url()


def run_overview(open_env, html, *, script=None, store=None):
    env = open_env(html, url=OV, script=script if script is not None else SCRIPT, store=store)
    env.page.evaluate(
        "() => document.addEventListener('click', e => { const a = e.target.closest('a,button'); if (a) window.__ev.push('click:' + a.textContent.trim()) }, true)"
    )
    assert env.call("do-run-assessment")["handled"] is True
    return env, env.run_finished(timeout=60000)


def skipped_why(run):
    assert run["solved"] == 0
    assert len(run["skipped"]) == 1, run["skipped"]
    return run["skipped"][0]["why"]


# ----------------------------------------------------------------- skip logic

def test_where_am_i_on_an_overview(open_env):
    env = open_env(fx.overview_html(questions=QS()), url=OV)
    assert env.call("do-where")["where"] == "overview"
    assert env.call("do-ping")["kind"] == ""


@pytest.mark.parametrize("text", [
    "Respondus LockDown Browser is required to take this test",
    "You must use LockDown Browser",
])
def test_respondus_is_never_opened(open_env, text):
    env, run = run_overview(open_env, fx.overview_html(extra=f"<li>{text}</li>", questions=QS()))
    assert skipped_why(run) == "needs Respondus LockDown Browser"
    assert not any(e.startswith("start") or e == "attempt-opened" for e in env.ev())
    assert "click:Start attempt" not in env.ev()


def test_proctored_is_never_opened(open_env):
    env, run = run_overview(open_env, fx.overview_html(extra="<li>This test is proctored</li>", questions=QS()))
    assert skipped_why(run) == "proctored"
    assert "click:Start attempt" not in env.ev()


def test_respondus_beats_proctored(open_env):
    env, run = run_overview(open_env, fx.overview_html(extra="<li>Proctored with Respondus LockDown Browser</li>", questions=QS()))
    assert skipped_why(run) == "needs Respondus LockDown Browser"


def test_zero_attempts_left_without_a_start_link(open_env):
    env, run = run_overview(open_env, fx.overview_html(attempts="0 attempts left", start=None, questions=QS()))
    assert skipped_why(run) == "0 attempts left"
    assert not [e for e in env.ev() if e.startswith("click:")]


def test_no_start_link_and_no_attempt_count_gets_a_generic_reason(open_env):
    env, run = run_overview(open_env, fx.overview_html(attempts="submitted yesterday", start=None, questions=QS()))
    assert "no Start button" in skipped_why(run)


@pytest.mark.parametrize("label", ["Start date", "Continue to course", "Begin", "Restart session"])
def test_unrelated_links_are_not_mistaken_for_start(open_env, label):
    extra = f'<li><a href="javascript:void(0)">{label}</a></li>'
    env, run = run_overview(open_env, fx.overview_html(attempts="0 attempts left", start=None, extra=extra, questions=QS()))
    assert skipped_why(run) == "0 attempts left"
    assert f"click:{label}" not in env.ev()


@pytest.mark.parametrize("left", ["3 attempts left", "2 attempts left"])
def test_start_attempt_two_is_retaken_while_attempts_remain(open_env, left):
    env, run = run_overview(open_env, fx.overview_html(start="Start attempt 2", attempts=left, questions=QS()))
    assert run["solved"] == 1 and run["skipped"] == []
    assert "attempt-opened" in env.ev()


@pytest.mark.parametrize("grade", ["Grade: 100/100", "Score 10 / 10", "Grade 100%"])
def test_full_marks_are_not_retaken(open_env, grade):
    env, run = run_overview(open_env, fx.overview_html(start="Start attempt 2", attempts="2 attempts left",
                                                       extra=f"<li>{grade}</li>", questions=QS()))
    assert skipped_why(run) == "already full marks"
    assert "attempt-opened" not in env.ev()


@pytest.mark.parametrize("grade", ["Grade: 80/100", "Score 9 / 10", "Grade 62%", "Due 9/17/26 Grade 7/10"])
def test_below_full_marks_is_retaken(open_env, grade):
    env, run = run_overview(open_env, fx.overview_html(start="Start attempt 2", attempts="3 attempts left",
                                                       extra=f"<li>{grade}</li>", questions=QS()))
    assert run["solved"] == 1 and run["skipped"] == []


def test_no_attempts_left_is_still_skipped_even_with_a_start_link(open_env):
    env, run = run_overview(open_env, fx.overview_html(start="Start attempt 2", attempts="0 attempts left", questions=QS()))
    assert skipped_why(run) == "0 attempts left"
    assert "attempt-opened" not in env.ev()


def test_continue_attempt_resumes_an_open_one(open_env):
    env, run = run_overview(open_env, fx.overview_html(start="Continue attempt", questions=QS()))
    assert run["solved"] == 1 and run["skipped"] == []


# ------------------------------------------------------------------ start flow

def test_normal_page_start_dialog_begin_then_solved_and_submitted(open_env):
    dlg = ("Begin attempt?", "You have 1 attempt and no time limit.", ["Cancel", "Begin"], "Begin")
    env, run = run_overview(open_env, fx.overview_html(attempts="1 attempt left", start_dialog=dlg, questions=QS()))
    assert run["solved"] == 1 and run["skipped"] == [] and run["note"] == ""
    ev = env.ev()
    assert "dialog-btn:Cancel" not in ev
    order = ["start-click", "dialog:Begin attempt?", "dialog-btn:Begin", "attempt-opened", "submit-click", "dialog:Submit Test?", "dialog-btn:Submit", "list-removed"]
    assert [ev.index(e) for e in order] == sorted(ev.index(e) for e in order)
    assert ev.count("start-click") == 1 and ev.count("dialog-btn:Begin") == 1
    assert env.page.evaluate("location.pathname").endswith(f"/attempt/{fx.ATTEMPT}")
    assert env.page.query_selector("ol.attempt-question-list") is None


def test_start_without_a_dialog(open_env):
    env, run = run_overview(open_env, fx.overview_html(questions=QS()))
    assert run["solved"] == 1
    assert not any(e.startswith("dialog:Begin") for e in env.ev())


@pytest.mark.parametrize("word", ["Respondus LockDown Browser", "proctoring"])
def test_start_dialog_that_mentions_respondus_or_proctoring_is_not_confirmed(open_env, word):
    dlg = ("Before you begin", f"This test uses {word}.", ["Cancel", "Begin"], "Begin")
    env, run = run_overview(open_env, fx.overview_html(start_dialog=dlg, questions=QS()))
    assert skipped_why(run) == "the attempt did not open"
    ev = env.ev()
    assert "dialog-btn:Begin" not in ev and "attempt-opened" not in ev


def test_start_dialog_with_other_affirmative_words(open_env):
    dlg = ("Time limit", "This test is timed. Continue?", ["Cancel", "Continue"], "Continue")
    env, run = run_overview(open_env, fx.overview_html(start_dialog=dlg, questions=QS()))
    assert run["solved"] == 1


def test_attempt_that_never_opens_is_skipped_not_hung(open_env):
    dlg = ("Begin attempt?", "ok", ["Cancel", "Begin"], "Nothing")
    env, run = run_overview(open_env, fx.overview_html(start_dialog=dlg, questions=QS()))
    assert skipped_why(run) == "the attempt did not open"


# ------------------------------------------------------------ course-level run

def course_pages(**overview):
    outline = fx.plain_html("course outline", title="Arabic 101")
    ov = fx.overview_html(questions=QS(), **overview)
    return {
        f"/ultra/courses/{fx.COURSE}/outline": outline,
        f"/ultra/courses/{fx.COURSE}/assessment/{fx.CONTENT}/overview": ov,
    }


def col(content, name, category, **extra):
    return {"contentId": content, "scoreProviderHandle": "resource/x-bb-assessment",
            "effectiveColumnName": name, "gradebookCategory": {"title": category}, **extra}


def test_course_run_skips_assignments_and_past_due_and_solves_the_rest(open_env):
    api = {
        "/learn/api/v1/users/me/memberships": {"results": [{"courseId": fx.COURSE, "course": {"name": "Arabic 101"}}]},
        f"/learn/api/v1/courses/{fx.COURSE}/gradebook/columns": {"results": [
            col(fx.CONTENT, "Quiz 1", "Test.name", dueDate="2099-01-01T00:00:00.000Z"),
            col("_800_1", "Essay Paper", "Assignment.name"),
            col("_801_1", "Old Quiz", "Test.name", dueDate="2020-01-01T00:00:00.000Z", enforceDueDate=True),
            {"contentId": "_802_1", "scoreProviderHandle": "resource/x-bb-document", "effectiveColumnName": "Reading"},
            {"scoreProviderHandle": "resource/x-bb-assessment", "effectiveColumnName": "No content id"},
        ]},
    }
    env = open_env(course_pages(), url=f"{fx.ORIGIN}/ultra/courses/{fx.COURSE}/outline", script=SCRIPT, api=api)
    assert env.call("do-where")["where"] == "course"
    assert env.call("do-run-course")["handled"] is True
    run = env.run_finished(timeout=90000)
    assert run["solved"] == 1
    assert {(s["title"], s["why"]) for s in run["skipped"]} == {
        ("Essay Paper", "assignment (not questions)"),
        ("Old Quiz", "past its due date"),
    }
    assert [q["title"] for q in run["queue"]] == ["Quiz 1"]


def test_course_run_with_nothing_to_open(open_env):
    api = {
        "/learn/api/v1/users/me/memberships": {"results": [{"courseId": fx.COURSE, "course": {"name": "Arabic 101"}}]},
        f"/learn/api/v1/courses/{fx.COURSE}/gradebook/columns": {"results": [col("_800_1", "Essay Paper", "Assignment.name")]},
    }
    env = open_env(course_pages(), url=f"{fx.ORIGIN}/ultra/courses/{fx.COURSE}/outline", api=api)
    env.call("do-run-course")
    run = env.run_finished()
    assert run["note"] == "nothing to open" and run["solved"] == 0
    assert run["skipped"][0]["why"] == "assignment (not questions)"


# ---------------------------------------------------------------- run ownership

def test_run_started_in_another_tab_is_not_picked_up(open_env):
    stale = {"active": True, "owner": "some-other-tab", "scope": "assessment", "started": 2 ** 41, "solved": 0,
             "skipped": [], "queue": None, "i": 0, "tries": 0}
    env = open_env(fx.attempt_html(QS()), script=SCRIPT, store={"atsRun": stale})
    env.settle(3500)
    assert env.asks() == []
    assert state(env)[0]["checked"] == []
    assert env.store()["atsRun"]["queue"] is None


def test_run_continues_to_the_next_assessment_after_a_submit_that_reloads_the_page(open_env):
    second = "_900_1"
    confirm = lambda c: f"/ultra/courses/{fx.COURSE}/assessment/{c}/confirmation"
    done = fx.plain_html("Your submission was successful! Confirmation number: 6a81b3d1", title="Submission")
    pages = {
        f"/ultra/courses/{fx.COURSE}/outline": fx.plain_html("course outline", title="Physics"),
        f"/ultra/courses/{fx.COURSE}/assessment/{fx.CONTENT}/overview":
            fx.overview_html(title="Quiz 1", attempts="3 attempts left", start="Start attempt 2", questions=QS(), confirm_url=confirm(fx.CONTENT)),
        f"/ultra/courses/{fx.COURSE}/assessment/{second}/overview":
            fx.overview_html(title="Quiz 2", attempts="3 attempts left", content=second, questions=QS(), confirm_url=confirm(second)),
        confirm(fx.CONTENT): done,
        confirm(second): done,
    }
    api = {
        "/learn/api/v1/users/me/memberships": {"results": [{"courseId": fx.COURSE, "course": {"name": "Physics"}}]},
        f"/learn/api/v1/courses/{fx.COURSE}/gradebook/columns": {"results": [
            col(fx.CONTENT, "Quiz 1", "Test.name", dueDate="2098-01-01T00:00:00.000Z"),
            col(second, "Quiz 2", "Test.name", dueDate="2099-01-01T00:00:00.000Z"),
        ]},
    }
    env = open_env(pages, url=f"{fx.ORIGIN}/ultra/courses/{fx.COURSE}/outline", script=SCRIPT, api=api)
    assert env.call("do-run-course")["handled"] is True
    run = env.run_finished(timeout=120000)
    assert run["solved"] == 2 and run["skipped"] == [] and run["note"] == ""
