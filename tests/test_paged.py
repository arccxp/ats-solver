"""Paged mode: one question per page, a Next button, Submit once the last page is answered."""
import fixtures as fx
from conftest import state


def pages_of(n):
    return [[fx.mcq(i + 1, f"Question text number {i + 1} here", ["a", "b", "c"])] for i in range(n)]


def answers(env):
    """checked option per question across every page, read from the detached page nodes the fixture keeps."""
    return env.page.evaluate(
        "() => window.__pages.flat().map(li => [...li.querySelectorAll('input')].flatMap((i, n) => i.checked ? [n] : []))"
    )


def test_every_page_is_answered_then_next_disappears(open_env):
    env = open_env(
        fx.attempt_html(pages_of(3), paged=True),
        script=[{"match": f"number {i + 1}", "reply": {"index": i % 3}} for i in range(3)],
    )
    assert env.call("do-ping")["kind"] == "mcq"
    env.call("do-solve")
    env.wait_hud(r"answered 3/3", timeout=30000)
    assert answers(env) == [[0], [1], [2]]
    assert env.ev().count("next") == 2
    assert env.page.evaluate("window.__page()") == 2
    assert [a["payload"]["stem"] for a in env.asks()] == [f"Question text number {i + 1} here" for i in range(3)]


def test_paged_autosubmit_presses_submit_once_after_last_page(open_env):
    env = open_env(
        fx.attempt_html(pages_of(2), paged=True),
        script=[{"reply": {"index": 1}}],
        store={"autoSubmit": True},
    )
    env.call("do-solve")
    env.wait("window.__ev.includes('list-removed')", timeout=40000)
    ev = env.ev()
    assert ev.count("submit-click") == 1
    assert ev.index("next") < ev.index("submit-click")
    assert ev.index("page:1") < ev.index("submit-click")


def test_paged_without_autosubmit_leaves_the_attempt_open(open_env):
    env = open_env(fx.attempt_html(pages_of(2), paged=True), script=[{"reply": {"index": 0}}])
    env.call("do-solve")
    env.wait_hud(r"answered 2/2", timeout=30000)
    env.settle(2000)
    assert "submit-click" not in env.ev()


def test_next_disabled_on_last_page_also_ends_the_walk(open_env):
    env = open_env(
        fx.attempt_html(pages_of(2), paged=True, next_last="disabled"),
        script=[{"reply": {"index": 2}}],
    )
    env.call("do-solve")
    env.wait_hud(r"answered 2/2", timeout=30000)
    assert env.ev().count("next") == 1


def test_slow_page_render_does_not_double_answer_or_skip_a_page(open_env):
    """Next takes 2.5 s to repaint, longer than the 1.2 s the old fixed sleep allowed (reviewer item 1)."""
    env = open_env(
        fx.attempt_html(pages_of(3), paged=True, page_delay=2500),
        script=[{"match": f"number {i + 1}", "reply": {"index": 1}} for i in range(3)],
    )
    env.call("do-solve")
    env.wait_hud(r"answered 3/3", timeout=60000)
    assert answers(env) == [[1], [1], [1]]
    assert env.ev().count("next") == 2
    assert len(env.asks()) == 3


def test_paged_with_an_essay_on_page_two_never_submits(open_env):
    pages = [
        [fx.mcq(1, "Question text number 1 here", ["a", "b"])],
        [fx.essay(2, "Write a long essay about it.")],
        [fx.mcq(3, "Question text number 3 here", ["a", "b"])],
    ]
    env = open_env(fx.attempt_html(pages, paged=True), script=[{"reply": {"index": 1}}], store={"autoSubmit": True})
    env.call("do-solve")
    env.wait_hud(r"left 1 that cannot be answered", timeout=40000)
    env.settle(2500)
    assert answers(env) == [[1], [], [1]]
    assert "submit-click" not in env.ev()


def test_page_that_never_changes_stops_instead_of_looping(open_env):
    """A Next button that does nothing: the run must give up rather than answer the same page 100 times."""
    env = open_env(fx.attempt_html(pages_of(2), paged=True), script=[{"reply": {"index": 0}}], store={"autoSubmit": True})
    env.page.evaluate(
        "() => { const n = document.getElementById('next'); n.replaceWith(n.cloneNode(true)); "
        "document.getElementById('next').addEventListener('click', () => window.__ev.push('next-noop')); }"
    )
    env.call("do-solve")
    env.wait_hud(r"next page did not open", timeout=40000)
    assert "submit-click" not in env.ev()


def test_icon_only_next_named_by_aria_label_is_found(open_env):
    env = open_env(
        fx.attempt_html(pages_of(3), paged=True, next_style="aria"),
        script=[{"match": f"number {i + 1}", "reply": {"index": i % 3}} for i in range(3)],
    )
    env.call("do-solve")
    env.wait_hud(r"answered 3/3", timeout=30000)
    assert answers(env) == [[0], [1], [2]]
    assert env.ev().count("next") == 2


def test_next_that_is_enabled_a_moment_after_answering_is_waited_for(open_env):
    env = open_env(
        fx.attempt_html(pages_of(3), paged=True, next_lag=1500),
        script=[{"match": f"number {i + 1}", "reply": {"index": i % 3}} for i in range(3)],
    )
    env.call("do-solve")
    env.wait_hud(r"answered 3/3", timeout=40000)
    assert answers(env) == [[0], [1], [2]]
    assert env.ev().count("next") == 2
