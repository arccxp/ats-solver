# ATS Solver: quick start

Five minutes, and you need Chrome.

## 1. Load the extension

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Press **Load unpacked** and pick the folder that has `manifest.json` directly inside it.
3. Pin the extension so its icon stays in the toolbar.

After you change or update the files, press the reload button on the extension's card, then reload the Blackboard tab. The page script attaches when a tab loads, so an older tab keeps the old copy until you press F5.

## 2. Give it a model

1. Open the extension's **Options**.
2. Choose a service. OpenRouter is the default: make a key at [openrouter.ai/keys](https://openrouter.ai/keys) and paste it in.
3. Press **Test key**, then **Save**.

The DeepSeek and Gemini site logins need no key; the README says how each one works.

## 3. Sign in to Blackboard

Open `https://ats.blackboard.com`, press **Sign in with third-party account**, choose **ATS-SSO**, and sign in with your school account at the Microsoft page.

## 4. Run it

Open the popup on any Blackboard page. It shows the buttons that fit where you are:

- **Solve all courses**: goes through every course and every open test, answers it and submits.
- **Solve this course**: the same for the course you are in.
- **Start and solve this assessment**: on one test's overview page.
- **Solve the open attempt**: on a test you already started. It submits only if **Submit automatically** is on.

`Ctrl+Shift+S` solves the open attempt and `Ctrl+Shift+X` stops a run. Leave the tab open while a run works.

## If something goes wrong

- **The popup says the page script is not there.** Reload the Blackboard tab and wait for it to finish loading.
- **A test was skipped.** The reason is in `atsRun.skipped`, stored in the extension's local storage. Assignments, essays, matching, ordering, tests with no attempts left, and anything behind Respondus LockDown Browser or proctoring are skipped on purpose.
- **A run stopped on an open attempt.** A question it cannot answer, or a failed click, leaves the attempt open and unsubmitted so you can finish it by hand.
- **A click or a blank did nothing.** The site's markup has probably changed. The selectors the extension relies on are in `ats.js`.
