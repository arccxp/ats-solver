# ATS Solver

A Chrome extension for `ats.blackboard.com`, the Blackboard Ultra site. It finds your tests, sends each question to an AI model, and clicks the answers. The [quick start](QUICKSTART.md) takes five minutes.

The extension reads the site's current markup and its REST API. When Blackboard changes either, it will stop working until someone updates the selectors in `ats.js`.

## What it answers

- Multiple choice and true/false, with or without a reading passage
- Select all that apply
- Short text answers and fill in the blanks
- Reading comprehension: a text block above the questions is sent with every question after it
- Figures: a question that points at a picture the page text lacks goes to the model with a screenshot

It leaves essays, matching, ordering and anything it does not recognise alone, and it will not submit an attempt that still has one. It skips assignments (file uploads and written work), assessments with no attempts left, assessments whose overview already shows full marks, and anything behind **Respondus LockDown Browser** or proctoring. The popup lists each skipped title with the reason.

An assessment that already has an attempt handed in (the overview offers "Start attempt 2") is **retaken** while attempts remain and the grade is below full marks. The full-marks check looks for text such as `Grade: 100/100`, `Score 10 / 10` or `Grade 100%` on the overview. That wording has not been checked against the live site, so an unrecognised format means a retake. If your course keeps the last attempt rather than the best one, a retake can lower the grade.

Only multiple choice has been run against a live test. The other types follow Blackboard's markup conventions and are untested; if one misbehaves, the attempt is left open for you.

## The popup

The popup checks where the tab is and shows the buttons that apply.

| You are on | Buttons |
| --- | --- |
| An open attempt | **Solve the open attempt** |
| An assessment's overview | **Start and solve this assessment**, **Solve this course**, **Solve all courses** |
| A course | **Solve this course**, **Solve all courses** |
| Anywhere else in Blackboard | **Solve all courses** |

**Solve all courses** reads your course list and every course's gradebook through the site's own API, then opens each assessment's overview, starts or continues the attempt, answers it and submits. Assessments are taken nearest due date first. If a question cannot be answered, it leaves the attempt open and does not submit.

**Solve the open attempt** answers an attempt you started yourself. It submits only when **Submit automatically** is on in the popup. Auto runs always submit what they finish.

`Ctrl+Shift+S` solves the open attempt. `Ctrl+Shift+X` and the Stop button stop a run. The script checks for a stop before Start, between answer batches and before Submit, so nothing submits after you press it. A run switches itself off after two hours.

## How it picks answers

- The model quotes the words that decide the answer and tests every choice before it answers. The reply is JSON with `evidence`, `answer`, `index`, `confidence` and `why`.
- An answer below 0.9 confidence, or any question with a passage, goes out again with the choices reversed. When the two answers disagree, a third order breaks the tie. Set `verify` to `false` to skip the extra calls.
- Questions that need no screenshot go to the model two at a time while the script clicks through the page in order.
- DeepSeek and the Gemini site login start a fresh chat for every question. Turn on **Keep using one chat** in Options to send all questions to one chat; a new chat then starts after 30 questions.
- Arabic and English tests both work; the text goes to the model as it appears on the page.

## When something goes wrong

- A model that returns nothing, hits a limit or answers "something went wrong" is asked again up to three times, with growing waits. The status line shows the model's own reason. If it never recovers, the run stops with the attempt left open.
- A background worker that is not listening yet is retried for a few seconds.
- After the last question, **Submit** and **Submit Late** (after the due date) are both pressed and the confirmation dialog is accepted. Blackboard then loads its "Your submission was successful!" page; the run counts that as handed in and moves to the next assessment.
- If the Submit button is missing or never turns on, the status line says so and leaves the attempt for you.

## Install

1. Open `chrome://extensions` and turn on Developer mode.
2. Click Load unpacked and select this folder.
3. Open the extension's Options, choose a service, paste its key, click Test key, then Save.
4. Sign in to `ats.blackboard.com`: press **Sign in with third-party account**, then **ATS-SSO**, and use your school account.

Five services are available, and the extension uses the one you pick in Options.

- **OpenRouter** (default): one key from [openrouter.ai/keys](https://openrouter.ai/keys) reaches many models. The default model is `deepseek/deepseek-v4.1-flash`.
- **Google Gemini**: your own key from [aistudio.google.com/apikey](https://aistudio.google.com/apikey). The default model is `gemini-2.5-flash`.
- **OpenAI**: a key from [platform.openai.com/api-keys](https://platform.openai.com/api-keys). The default model is `gpt-5-mini`.
- **DeepSeek**: your own chat.deepseek.com login, with no key to buy. Sign in on the site, then press "Copy token from the site" in Options. The site's chat cannot read images, so figure questions go to the model as text.
- **Google Gemini (site login)**: your own gemini.google.com login, with no key to buy. Keep a signed-in tab open, because the extension sends its questions from that tab. This service reads images.

Each service keeps its own key, model and fallback model. Your browser stores the key and sends it to that service and nowhere else.

## Settings

Options holds the provider, key, model, fallback model and the chat setting. The popup has a **Submit automatically** switch for the open-attempt path and a **Screenshot** setting: Auto sends a picture when a question needs one, and Never sends none.

Two settings have no screen. Set them from the service worker console on `chrome://extensions`, for example `chrome.storage.local.set({ concurrency: 2 })`.

| Key | Default | Effect |
| --- | --- | --- |
| `concurrency` | `2` | Model calls in flight at once for questions without a screenshot |
| `verify` | `true` | Second and third opinions on doubtful and passage questions |
| `rateWait` | `10000` | Milliseconds before the first retry when the model fails for the moment; later retries wait two and three times as long |

## Tests

`tests/` holds an offline suite that loads `ats.js` into a headless Chromium with a mocked `chrome.*` API and synthetic Blackboard pages. It never contacts the real site. Only the multiple-choice markup was copied from the live site; the other question types, the paged mode, the Start dialog and the confirmation page are modelled, so a pass there is not proof the live site behaves the same.

```
pip install pytest playwright
playwright install chromium
cd tests && python3 -m pytest -q
```

`test_e2e.py` runs a whole course: skipped assessments, a late retake that ends on the confirmation page, a model hiccup and a quiz with every supported question type. `tests/FINDINGS.md` lists the bugs the suite found and how each was fixed. Set `ATS_JS=/path/to/ats.js` to run the suite against another build.

## Credits

[Alef Solver](https://github.com/Owlsnet/alef-solver) by Owlsnet supplied the extension layout, the provider setup and the README style. [arccxp](https://github.com/arccxp) wrote the LMS version this is forked from: the run loop, the voting and the popup that adapts to the page. The Blackboard Ultra version replaces its page script.
