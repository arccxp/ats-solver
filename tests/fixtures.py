"""Synthetic Blackboard Ultra pages, built from the structure of the one real attempt page that was captured
(ol.attempt-question-list > li > bb-assessment-question > div.assessment-question.js-question-type-X, MUI
label/input choices, read-only Quill editors, footer Save and Close / Submit, role=dialog confirmation).

Only multiple choice (radio) markup was verified against the live site. Everything else here is modelled on
it and on Blackboard conventions, so a failing test may mean the fixture is wrong about the site: say so in
FINDINGS.md before calling it an ats.js bug."""
import json

COURSE, CONTENT, ATTEMPT = "_29757_1", "_511329_1", "_934387_1"
ORIGIN = "https://ats.blackboard.com"
LETTERS = "ABCDEFGHIJ"


def overview_url(course=COURSE, content=CONTENT):
    return f"{ORIGIN}/ultra/courses/{course}/assessment/{content}/overview?courseId={course}"


def attempt_url(course=COURSE, content=CONTENT, attempt=ATTEMPT):
    return f"{ORIGIN}/ultra/courses/{course}/assessment/{content}/attempt/{attempt}?courseId={course}"


# ------------------------------------------------------------------ questions

def editor(inner, readonly=True):
    """A Quill rich-text block. Read-only ones are contenteditable=false; every one carries the hidden clipboard."""
    return (
        '<div class="bb-editor-root bb-editor-heading-h4" role="presentation">'
        '<div class="editor-content-container keyboard-tooltip-container no-toolbar">'
        f'<div role="presentation" class="bb-editor-container ql-container{" ql-disabled is-read-only" if readonly else ""}">'
        f'<div class="ql-editor bb-editor" data-gramm="false" contenteditable="{"false" if readonly else "true"}">{inner}</div>'
        '<div class="ql-clipboard" contenteditable="true" tabindex="-1" aria-hidden="true"></div>'
        "</div></div></div>"
    )


def _shell(n, qtype, content, points=5, header=True):
    head = (
        f'<div class="question-header has-question-title is-read-only"><h3 class="question-label">Question {n}</h3>'
        f'<div id="point-value-description-{n}" class="point-value"><bdi>{points}</bdi> Points</div></div>'
        if header else ""
    )
    return (
        "<li><bb-assessment-question>"
        f'<div class="assessment-question js-question-type-{qtype}">'
        f'<form name="questionForm" class="ng-pristine ng-valid"><span class="sr-only" id="question-label-id-{n}">Question {n}</span>'
        f'{head}<div class="question-content"><bb-question-attempt>{content}</bb-question-attempt></div>'
        "</form></div></bb-assessment-question></li>"
    )


def _stem_block(n, stem):
    return (
        f'<div id="multiple-answer-group-label-:r{n}:" class="js-multiple-answer-group-label">'
        f'<div class="makeStyleshideOffScreen-0-2-185">Question {n}</div>'
        f'<div class="bb-editor-wrapper read-only">{editor(f"<p>{stem}</p>")}</div></div>'
    )


def _choice_group(n, control, options, stem, role, rich=True):
    items = []
    cls = "MuiRadio-root" if control == "radio" else "MuiCheckbox-root"
    for i, text in enumerate(options):
        body = editor(f"<p>{text}</p>") if rich else f'<span class="plain">{text}</span>'
        items.append(
            f'<li class="MuiListItem-root MuiListItem-gutters" data-analytics-id="assessments.listItem.{i}">'
            f'<label class="MuiFormControlLabel-root"><span class="MuiButtonBase-root {cls}">'
            f'<input type="{control}" class="PrivateSwitchBase-input" value="" name="mui-{n}"><span class="makeStylesroot"></span></span>'
            f'<span class="MuiTypography-root MuiTypography-body1 MuiFormControlLabel-label"><span class="sr-only">Option {LETTERS[i]}</span>'
            f'<div class="makeStylesanswerOptionText">{body}</div></span></label></li>'
        )
    group_cls = "MuiRadioGroup-root" if control == "radio" else "MuiFormGroup-root"
    return (
        '<div class="MuiFormControl-root makeStylesmultipleAnswerQuestion">'
        f'{_stem_block(n, stem)}'
        f'<div class="MuiFormGroup-root {group_cls}" role="{role}" aria-labelledby="multiple-answer-group-label-:r{n}:">'
        f'<ul class="MuiList-root MuiList-padding">{"".join(items)}</ul></div></div>'
    )


def mcq(n, stem, options, qtype="multipleanswer", rich=True):
    """Single choice, radios inside role=radiogroup: the markup that was verified live."""
    return _shell(n, qtype, _choice_group(n, "radio", options, stem, "radiogroup", rich))


def true_false(n, stem, rich=True, qtype="truefalse"):
    return _shell(n, qtype, _choice_group(n, "radio", ["True", "False"], stem, "radiogroup", rich))


def select_all(n, stem, options, qtype="multipleanswer"):
    """Select all that apply: MUI checkboxes in a role=group."""
    return _shell(n, qtype, _choice_group(n, "checkbox", options, stem, "group"))


def _text_input(label="Answer"):
    return (
        '<div class="MuiFormControl-root"><div class="MuiInputBase-root MuiOutlinedInput-root">'
        f'<input type="text" aria-label="{label}" class="MuiInputBase-input MuiOutlinedInput-input" value="">'
        "</div></div>"
    )


def short_answer(n, stem, qtype="shortanswer"):
    return _shell(n, qtype, f'<div class="question-text">{editor(f"<p>{stem}</p>")}</div>{_text_input()}')


def fill_blank(n, stem, blanks, qtype="fillintheblank"):
    rows = "".join(
        f'<div class="blank-row"><label>Blank {i + 1}</label>{_text_input(f"Blank {i + 1}")}</div>' for i in range(blanks)
    )
    return _shell(n, qtype, f'<div class="question-text">{editor(f"<p>{stem}</p>")}</div>{rows}')


def essay(n, stem, qtype="essay"):
    return _shell(
        n, qtype,
        f'<div class="question-text">{editor(f"<p>{stem}</p>")}</div>'
        f'<div class="bb-editor-wrapper">{editor("<p><br></p>", readonly=False)}</div>',
    )


def passage(text):
    return _shell("", "presentation", editor(f"<p>{text}</p>"), header=False)


# --------------------------------------------------------------------- pages

COMMON_JS = r"""
window.__ev = window.__ev || [];
window.__dialog = function (title, text, labels, onClick) {
  const d = document.createElement('div');
  d.setAttribute('role', 'dialog');
  d.className = 'notification success reveal-modal fade open in';
  d.setAttribute('aria-labelledby', 'dlg-title');
  d.style.cssText = 'display:block;position:fixed;top:40px;left:40px;width:420px;background:#fff;border:1px solid #333;padding:16px;z-index:9999';
  d.innerHTML = '<button class="close-x" aria-label=""></button><h2 id="dlg-title"></h2><p class="dlg-text"></p><div class="dlg-actions"></div><button class="close-y" aria-label=""></button>';
  d.querySelector('h2').textContent = title;
  d.querySelector('p').textContent = text;
  for (const label of labels) {
    const b = document.createElement('button');
    b.textContent = label;
    b.addEventListener('click', () => { __ev.push('dialog-btn:' + label); d.style.display = 'none'; onClick(label); });
    d.querySelector('.dlg-actions').appendChild(b);
  }
  document.body.appendChild(d);
  __ev.push('dialog:' + title);
  return d;
};

window.__bootAttempt = function () {
  const A = window.__ATTEMPT, cfg = A.cfg;
  document.body.insertAdjacentHTML('beforeend', A.body);
  const ol = document.querySelector('ol.attempt-question-list');
  const pages = A.pages.map(arr => arr.map(h => { const t = document.createElement('template'); t.innerHTML = h.trim(); return t.content.firstElementChild; }));
  window.__pages = pages;
  let cur = 0;
  window.__page = () => cur;
  const show = i => {
    cur = i;
    ol.replaceChildren(...pages[cur]);
    const nx = document.getElementById('next'), pv = document.getElementById('prev');
    if (nx) {
      const last = cur === pages.length - 1;
      nx.hidden = last && cfg.next_last === 'hidden';
      nx.disabled = last && cfg.next_last === 'disabled';
      if (cfg.next_style === 'aria') { nx.textContent = '›'; nx.setAttribute('aria-label', 'Next question'); }
      if (cfg.next_lag && !last) { nx.disabled = true; setTimeout(() => { nx.disabled = false; }, cfg.next_lag); }
    }
    if (pv) pv.disabled = cur === 0;
    __ev.push('page:' + cur);
  };
  const answered = li => !!li.querySelector('input:checked') ||
    [...li.querySelectorAll('input[type=text]')].some(i => i.value.trim());
  const total = pages.flat().length;
  const counter = () => { document.getElementById('remaining').innerHTML = '<strong>' + (total - pages.flat().filter(answered).length) + '</strong> of ' + total + ' questions remaining'; };

  const submitBtn = document.getElementById('submit-btn');
  submitBtn.firstElementChild.textContent = cfg.submit_label;
  const setEnabled = on => { submitBtn.disabled = !on; submitBtn.classList.toggle('disabled', !on); };
  setEnabled(cfg.enable === 'always');
  let timer;
  const onAnswer = e => {
    counter();
    __ev.push('answer:' + (e.target.type || e.target.tagName));
    if (cfg.enable === 'change') setEnabled(true);
    else if (cfg.enable === 'lag') { setEnabled(false); clearTimeout(timer); timer = setTimeout(() => setEnabled(true), cfg.lag); }
  };
  document.addEventListener('change', onAnswer, true);
  document.addEventListener('input', e => { if (e.target.type === 'text') onAnswer(e); }, true);

  const finish = () => {
    const list = document.querySelector('ol.attempt-question-list');
    if (cfg.blink) {            // the list vanishes during an SPA re-render and comes back: not a submission
      const parent = list.parentNode; list.remove(); __ev.push('list-blink');
      setTimeout(() => parent.appendChild(list), cfg.blink);
      return;
    }
    if (cfg.confirm_url) { __ev.push('submit-navigates'); location.href = cfg.confirm_url; return; }   // a full page load, like the real confirmation page
    list?.remove(); __ev.push('list-removed');
  };
  submitBtn.addEventListener('click', () => {
    __ev.push('submit-click');
    if (cfg.submit === 'direct') { setTimeout(finish, cfg.submit_delay); return; }
    __dialog('Submit Test?', "After you submit, you can't edit this test. Do you want to continue?", ['Cancel', cfg.submit_label],
      label => { if (label !== 'Cancel') setTimeout(finish, cfg.submit_delay); });
  });

  const nx = document.getElementById('next'), pv = document.getElementById('prev');
  if (nx) nx.addEventListener('click', () => { __ev.push('next'); setTimeout(() => show(Math.min(cur + 1, pages.length - 1)), cfg.page_delay); });
  if (pv) pv.addEventListener('click', () => { __ev.push('prev'); setTimeout(() => show(Math.max(cur - 1, 0)), cfg.page_delay); });
  document.getElementById('save-btn').addEventListener('click', () => __ev.push('save-click'));
  if (cfg.render_delay) setTimeout(() => show(0), cfg.render_delay); else show(0);
  counter();
};
"""

ATTEMPT_BODY = """
<div id="attempt-root">
  <h2>Test Content</h2>
  <span id="remaining" role="status" aria-live="polite"></span>
  <section><ol class="question-list attempt-question-list"></ol></section>
  <footer class="submit-footer">
    <div class="pager" __PAGER__>
      <button type="button" id="prev" class="button">Previous</button>
      <button type="button" id="next" class="button">Next</button>
    </div>
    <div class="save-submit-buttons"><div class="equal-buttons buttons-2">
      <button type="button" id="save-btn" class="button button--secondary">Save and Close</button>
      <button type="button" id="submit-btn" class="button js-send-draft-button"><bb-translate>Submit</bb-translate></button>
    </div></div>
  </footer>
</div>
"""

ATTEMPT_CFG = dict(
    enable="change",      # always | change | lag  (when the footer Submit stops being disabled)
    lag=0,                # ms of autosave delay before Submit is enabled again (enable="lag")
    submit="dialog",      # dialog | direct
    submit_label="Submit",  # the footer button, and the dialog's confirm button ("Submit Late" after the due date)
    submit_delay=250,     # ms between confirming and the attempt list disappearing
    page_delay=150,       # ms a Next/Previous click takes to render
    next_last="hidden",   # hidden | disabled: what Next does on the last page
    next_style="text",    # text | aria: icon-only Next whose name is only in aria-label
    next_lag=0,           # ms Next stays disabled after a page appears
    confirm_url="",       # when set, handing in loads this page (a full navigation) instead of removing the list
    blink=0,              # ms the list is gone after confirming, then it returns (a re-render, not a submit)
    render_delay=0,       # ms the question list stays empty after the attempt opens
)


def _attempt_data(pages, paged, cfg):
    body = ATTEMPT_BODY.replace("__PAGER__", "" if paged else 'style="display:none"')
    return {"cfg": {**ATTEMPT_CFG, **cfg}, "body": body, "pages": pages}


def _page(inner_body, scripts):
    return (
        '<!DOCTYPE html><html lang="en-us"><head><meta charset="utf-8"><title>View Assessment</title>'
        "<style>body{font:14px sans-serif} button{padding:4px 10px;margin:2px} li{list-style:none} .sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}"
        ".makeStyleshideOffScreen-0-2-185{position:absolute;left:-9999px}</style></head>"
        f"<body>{inner_body}<script>{scripts.replace('</', '<' + chr(92) + '/')}</script></body></html>"
    )


def attempt_html(questions, *, paged=False, **cfg):
    """An open attempt. `questions` is a list of li strings, or (paged=True) a list of such lists, one per page."""
    pages = questions if paged else [questions]
    data = _attempt_data(pages, paged, cfg)
    return _page("", f"window.__ATTEMPT={json.dumps(data)};{COMMON_JS}window.__bootAttempt();")


def overview_html(
    *, title="Quiz 1", attempts="1 attempt left", extra="", start="Start attempt", start_dialog=None,
    questions=None, open_delay=300, content=None, **cfg,
):
    """An assessment overview. Clicking the Start link opens `start_dialog` = (title, text, labels, affirmative)
    when given, then swaps in an attempt (history.pushState to /attempt/...) the way the SPA does."""
    data = _attempt_data([questions or []], False, cfg)
    attempt_path = f"/ultra/courses/{COURSE}/assessment/{content or CONTENT}/attempt/{ATTEMPT}"
    link = f'<a href="javascript:void(0)" id="start" class="button">{start}</a>' if start else ""
    body = (
        '<div id="overview"><h1>' + title + "</h1>"
        '<ul class="assessment-features"><li><span class="settings-label">Assessment due date</span> <span>No due date</span></li>'
        f'<li><span class="settings-label">Attempts</span> <span><bdi>{attempts.split()[0]}</bdi> {" ".join(attempts.split()[1:])}</span></li>{extra}</ul>'
        f"{link}</div>"
    )
    script = f"""
window.__ATTEMPT={json.dumps(data)};{COMMON_JS}
const openAttempt = () => setTimeout(() => {{
  document.getElementById('overview').remove();
  history.pushState({{}}, '', {json.dumps(attempt_path)});
  window.__bootAttempt();
  __ev.push('attempt-opened');
}}, {open_delay});
const startEl = document.getElementById('start');
if (startEl) startEl.addEventListener('click', () => {{
  __ev.push('start-click');
  const dlg = {json.dumps(start_dialog)};
  if (!dlg) return openAttempt();
  __dialog(dlg[0], dlg[1], dlg[2], label => {{ if (label === dlg[3]) openAttempt(); }});
}});
"""
    return _page(body, script)


def plain_html(text, title="Page"):
    return _page(f"<h1>{title}</h1><p>{text}</p>", "")
