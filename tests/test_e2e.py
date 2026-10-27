"""One course run through everything at once, in the order a real day goes: assessments that must be left alone,
a retake of a low grade that is handed in late (the site loads its confirmation page), a model that hiccups once,
and a last quiz with every kind of question the extension can answer."""
import fixtures as fx

COURSE_OUTLINE = f"{fx.ORIGIN}/ultra/courses/{fx.COURSE}/outline"
RESPONDUS, ZERO, FULL, LATE, MIXED = "_910_1", "_911_1", "_912_1", "_913_1", "_914_1"


def col(content, name, category, due, **extra):
    return {"contentId": content, "scoreProviderHandle": "resource/x-bb-assessment", "effectiveColumnName": name,
            "gradebookCategory": {"title": category}, "dueDate": due, **extra}


def path(content, page="overview"):
    return f"/ultra/courses/{fx.COURSE}/assessment/{content}/{page}"


def build():
    late_qs = [fx.mcq(i, f"Question D{i} pick one", ["a", "b", "c"]) for i in (1, 2, 3)]
    mixed_qs = [
        fx.mcq(1, "Question E1 pick one", ["a", "b", "c"]),
        fx.true_false(2, "Question E2 true or false"),
        fx.select_all(3, "Question E3 pick all that apply", ["w", "x", "y", "z"]),
        fx.short_answer(4, "Question E4 capital of France"),
    ]
    done = fx.plain_html("Your submission was successful! Confirmation number: 6a81b3d1", title="Submission")
    pages = {
        f"/ultra/courses/{fx.COURSE}/outline": fx.plain_html("course outline", title="Physics"),
        path(RESPONDUS): fx.overview_html(title="Lockdown quiz", content=RESPONDUS,
                                          extra="<li>Respondus LockDown Browser is required to take this test</li>",
                                          questions=late_qs),
        path(ZERO): fx.overview_html(title="Used up", content=ZERO, attempts="0 attempts left", start=None, questions=late_qs),
        path(FULL): fx.overview_html(title="Perfect already", content=FULL, attempts="2 attempts left", start="Start attempt 2",
                                     extra="<li>Grade: 100/100</li>", questions=late_qs),
        path(LATE): fx.overview_html(title="Retake me", content=LATE, attempts="2 attempts left", start="Start attempt 2",
                                     extra="<li>Grade: 60/100</li>", questions=late_qs,
                                     submit_label="Submit Late", confirm_url=path(LATE, "confirmation")),
        path(LATE, "confirmation"): done,
        path(MIXED): fx.overview_html(title="Everything", content=MIXED, attempts="1 attempt left", questions=mixed_qs),
    }
    api = {
        "/learn/api/v1/users/me/memberships": {"results": [{"courseId": fx.COURSE, "course": {"name": "Physics"}}]},
        f"/learn/api/v1/courses/{fx.COURSE}/gradebook/columns": {"results": [
            col(RESPONDUS, "Lockdown quiz", "Test.name", "2090-01-01T00:00:00.000Z"),
            col(ZERO, "Used up", "Test.name", "2091-01-01T00:00:00.000Z"),
            col(FULL, "Perfect already", "Test.name", "2092-01-01T00:00:00.000Z"),
            col("_915_1", "Essay Paper", "Assignment.name", "2092-06-01T00:00:00.000Z"),
            col("_916_1", "Old Quiz", "Test.name", "2020-01-01T00:00:00.000Z", enforceDueDate=True),
            col(LATE, "Retake me", "Test.name", "2094-01-01T00:00:00.000Z"),
            col(MIXED, "Everything", "Test.name", "2099-01-01T00:00:00.000Z"),
        ]},
    }
    script = [
        {"match": "Question D1", "reply": {"error": 'unparseable reply "Sorry, something went wrong. Please try your request again."'}, "times": 1},
        {"match": "Question D1", "reply": {"index": 0}},
        {"match": "Question D2", "reply": {"index": 1}},
        {"match": "Question D3", "reply": {"index": 2}},
        {"match": "Question E1", "reply": {"index": 2}},
        {"match": "Question E2", "reply": {"index": 1}},
        {"match": "Question E3", "reply": {"indices": [0, 2]}},
        {"match": "Question E4", "reply": {"words": ["Paris"]}},
    ]
    return pages, api, script


def test_whole_course_run(open_env):
    pages, api, script = build()
    env = open_env(pages, url=COURSE_OUTLINE, script=script, api=api, store={"rateWait": 100})
    assert env.call("do-run-course")["handled"] is True
    run = env.run_finished(timeout=180000)

    # Two handed in, in due-date order, and the run ended cleanly.
    assert run["note"] == ""
    assert run["solved"] == 2
    assert [q["title"] for q in run["queue"]] == ["Lockdown quiz", "Used up", "Perfect already", "Retake me", "Everything"]

    # Everything else was left alone, each for its own reason.
    assert {(s["title"], s["why"]) for s in run["skipped"]} == {
        ("Essay Paper", "assignment (not questions)"),
        ("Old Quiz", "past its due date"),
        ("Lockdown quiz", "needs Respondus LockDown Browser"),
        ("Used up", "0 attempts left"),
        ("Perfect already", "already full marks"),
    }

    # The model was asked for each question that was answered: D1 twice (one hiccup), the rest once.
    asked = [a["payload"]["stem"] for a in env.asks()]
    assert sum("Question D1" in s for s in asked) == 2
    assert sorted(s.split()[1] for s in asked if "Question D" in s) == ["D1", "D1", "D2", "D3"]
    assert sorted(s.split()[1] for s in asked if "Question E" in s) == ["E1", "E2", "E3", "E4"]
    assert not [s for s in asked if "Question D" not in s and "Question E" not in s], "an assessment that must be skipped was read"

    # The last quiz is still on screen, handed in, with exactly the scripted answers.
    answers = env.page.evaluate(
        "() => window.__pages.flat().map(li => [...li.querySelectorAll('input')].map(i => i.type === 'text' ? i.value : i.checked))"
    )
    assert answers[0] == [False, False, True]
    assert answers[1] == [False, True]
    assert answers[2] == [True, False, True, False]
    assert answers[3] == ["Paris"]
    assert env.page.query_selector("ol.attempt-question-list") is None
    assert "dialog-btn:Cancel" not in env.ev()
