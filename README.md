# SiteMate: an AI assistant for construction site managers

> **In one sentence:** SiteMate turns what happens on a building site (a voice note, a daily report, an email) into a clear decision, a cited summary or a ready-to-review letter, and keeps the site manager in charge of every final call.

## The problem it solves

Site managers spend a large part of their week on paperwork: reading daily reports, checking progress against the plan, chasing the cause of a delay, and writing formal letters (delay notices, extra-cost notices, notices of concern). The facts are scattered across site diaries, meeting minutes, emails, photos and PDFs. It is slow work, it is easy to miss a deadline, and a weak letter can cost money.

SiteMate does the legwork:

| Without SiteMate | With SiteMate |
| --- | --- |
| Compare today's report with the plan by hand | The app compares the signed quantity with the plan and flags the shortfall |
| Dig through emails and diaries to find out why work stopped | The app finds the passages that explain it and shows how confident it is |
| Write a delay notice from scratch and check the contract deadline | The app drafts the notice, names the deadline and cites its evidence |
| Wonder whether the project is slipping overall | The app shows progress against the baseline, a forecast completion date and a merit/demerit ledger |

**Important:** SiteMate drafts and suggests. It does **not** give legal advice, and it never sends anything on its own. A person reviews and approves every notice.

## How it works (the short version)

```text
  Field note, voice note,        SiteMate reads it,          A person checks the
  report, email, photo   --->    links it to the plan   ---> evidence, edits the draft
  (typed, spoken or PDF)         and the evidence            and approves it
                                          |
                                          v
                        Alerts, summaries, performance scores,
                        draft notices (export as PDF or Word)
```

Three rules keep it trustworthy:

1. **Numbers come from code, not from the AI.** Quantities, shortfalls, percentages and dates are calculated by ordinary, testable code. The AI only reads text and writes wording.
2. **Everything is cited.** Each statement points to the exact page, row or quote it came from. A statement with no source is thrown away.
3. **A human decides.** Foreman, site manager and approver each have their own role and screens.

## Who uses it

| Role | What they do in the app |
| --- | --- |
| **Foreman** | Reports a problem by typing or speaking, then confirms the facts the app extracted. |
| **Site manager** | Checks signed quantities against the plan, reviews alerts and performance, and prepares notices and the daily site report. |
| **Approver** | Reviews a notice and its evidence, asks for changes or approves it, then downloads it as PDF or Word. |

## What you can do in the app

| Screen | What it is for |
| --- | --- |
| **Today** | The morning dashboard: yesterday's output, open alerts and actions. |
| **Capture / Report a problem** | Type or dictate a field note. The app pulls out the facts (what, where, when, which machine). |
| **Alerts and Incidents** | Shortfalls against plan, with the probable cause, supporting quotes and a confidence score. |
| **Drafts and Notices** | Delay, extra-cost, defect and concern notices, with review, approval and PDF/Word export. |
| **Documents and Search** | Every report, email, minute, diary entry and photo, searchable, with the original file one click away. |
| **Schedule and Actions** | The programme, plus open action items and their owners. |
| **Recaps** | Short summaries of a day or period. |
| **Performance** | Daily and overall evaluation against the baseline plan: progress, trend, forecast completion, merits and demerits. You can upload the plan PDF here. |
| **Time control (header clock)** | Replay the project as it looked at an earlier moment, for demos and audits. |

## The demo project

The repository ships with a fictional project so you can try everything without real data. All names, figures and documents are made up.

- **Riverside Office Block** is the original demo story: an excavator breaks down in Zone B, the foreman records it, the manager compares **100 m³ planned** with **65 m³ signed**, and the approver reviews the resulting notice.
- **Riverside Residences - Block B** is the set of five mock plan PDFs in [mock_data/](mock_data/): programme, resource/cost/contract plan, 2D structural drawings, 3D model views and a daily task plan. They are the plan the Performance screen measures against. They agree with each other (same dates, quantities and completion date of 8 July 2027).

## Choose your starting point

| I want to... | Go to |
| --- | --- |
| Look around quickly, with no accounts or setup | [Quick look (5 minutes)](#quick-look-5-minutes) |
| Sign in as each role, save reports and export documents | [Full setup](#full-setup-live-data) |
| Run it on an Android phone | [Android](#android-phone) |
| Understand the code | [How the project is organised](#how-the-project-is-organised) |
| Fix an error | [Troubleshooting](#troubleshooting) |

## Quick look (5 minutes)

You only need **Node.js 24** (it includes npm) and Git. No database, no API key.

```sh
git clone https://github.com/sahithichowdaryB/construction-assistant.git
cd construction-assistant/frontend
```

**macOS · Terminal**

```sh
npm ci
cp -n .env.example .env.local
npm run dev -- --port 3000
```

**Windows · PowerShell**

```powershell
npm.cmd ci
if (!(Test-Path .env.local)) { Copy-Item .env.example .env.local }
npm.cmd run dev -- --port 3000
```

Open <http://localhost:3000/today>. The example settings turn on `NEXT_PUBLIC_USE_FIXTURES=true`, so the app shows the built-in demo records. Set the clock in the header to **10 Nov 17:30**, open **Documents** and find the signed 10 November report.

Sign-in, saved captures and exports need the live setup below.

## Full setup (live data)

Think of the app as four cooperating parts:

| Part | What it does | Runs on |
| --- | --- | --- |
| **Web app** (`frontend`) | The screens you click. Built with Next.js. | port 3000 |
| **API** (`backend`) | Business logic, calculations, exports. Built with FastAPI (Python). | port 8000 |
| **Database** | PostgreSQL (we use Supabase) stores projects, reports, sessions and results. | cloud or local |
| **AI helpers** | Claude reads text and drafts wording. Whisper turns speech into text. | Anthropic API / port 8001 |

You can still browse seeded records and check quantities without an Anthropic key. The AI-backed features (classifying captures, summaries, drafting) need one.

### 1. Install the backend

Use **Python 3.12**. Open a terminal at the repository root.

**macOS · Terminal**

```sh
cd backend
python3.12 -m venv .venv
./.venv/bin/python -m pip install -r requirements.txt
cp -n .env.example .env
```

**Windows · PowerShell**

```powershell
cd backend
py -3.12 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
if (!(Test-Path .env)) { Copy-Item .env.example .env }
```

### 2. Connect and fill the database

**Joining a team that already has a database?** Use the `backend/.env` and demo passwords the team gives you, then go to step 3.

**Setting up your own?** Create a Supabase project with Auth enabled. In the **Connect** panel pick the **Session pooler** (port `5432`) and copy its host, project reference and database name into `backend/.env`. Keep the `postgresql+psycopg://` prefix and URL-encode special characters in passwords. See the [Supabase connection guide](https://supabase.com/docs/guides/database/connecting-to-postgres) and the [environment template](backend/.env.example).

| Setting in `backend/.env` | What to put there |
| --- | --- |
| `MIGRATION_DATABASE_URL` | Admin connection used for migrations and seeding (your database password). |
| `DATABASE_URL` | Read-only connection for the `sitemate_reader` role. Choose a password. |
| `AGENT_DATABASE_URL` | Connection for `sitemate_agent`, which saves field captures. Choose a separate password. |
| `OPS_DATABASE_URL` | Connection for `sitemate_ops`, which handles manager actions and background jobs. Choose a separate password. |
| `RIVERSIDE_DEMO_TOKEN` | A random secret. Generate one with `node -p "require('node:crypto').randomBytes(32).toString('hex')"`. |
| `ANTHROPIC_API_KEY` | Your Claude API key, for the AI-backed features. |

Run these once from `backend`. They create the tables, the three database roles and the demo data. The last command prints a password for each demo account, so save them.

**macOS · Terminal**

```sh
./.venv/bin/python -m alembic upgrade head
./.venv/bin/python provision_reader.py
./.venv/bin/python provision_agent.py
./.venv/bin/python provision_ops.py
./.venv/bin/python seed_riverside.py
./.venv/bin/python seed_demo_users.py
```

**Windows · PowerShell**

```powershell
.\.venv\Scripts\python.exe -m alembic upgrade head
.\.venv\Scripts\python.exe provision_reader.py
.\.venv\Scripts\python.exe provision_agent.py
.\.venv\Scripts\python.exe provision_ops.py
.\.venv\Scripts\python.exe seed_riverside.py
.\.venv\Scripts\python.exe seed_demo_users.py
```

**Optional: load the Block B plan set into the Performance screen.** This reads the five PDFs in `mock_data/`, checks that they agree, loads the baseline and creates demo reports. Add `--dry-run` first to preview without saving.

```sh
./.venv/bin/python plan_pdfs.py            # check the five PDFs agree with each other
./.venv/bin/python seed_daily_plan.py      # load them into the database
```

### 3. Start the app

In `frontend/.env.local` set:

```dotenv
NEXT_PUBLIC_USE_FIXTURES=false
SITEMATE_API_URL=http://127.0.0.1:8000
```

Keep the API and the web app running in separate terminals, and restart the web app after changing its settings.

| Process (folder) | macOS Terminal | Windows PowerShell |
| --- | --- | --- |
| API (`backend`) | `./.venv/bin/python -m uvicorn main:app --host 127.0.0.1 --port 8000` | `.\.venv\Scripts\python.exe -m uvicorn main:app --host 127.0.0.1 --port 8000` |
| Web app (`frontend`) | `npm run dev -- --port 3000` | `npm.cmd run dev -- --port 3000` |
| Background jobs (`backend`), when you want incident processing | `./.venv/bin/python worker.py` | `.\.venv\Scripts\python.exe worker.py` |

Check that the [database is healthy](http://127.0.0.1:8000/health/db), then [sign in](http://localhost:3000/login).

| Role | Demo email | A good first try |
| --- | --- | --- |
| Foreman | `foreman@riverside.example` | Open **Report a problem**, enter a field note and review the extracted facts. |
| Site manager | `manager@riverside.example` | Open the [Zone B replay](http://localhost:3000/manager?as_of=2026-11-10T17%3A30%3A00%2B01%3A00). Compare **100 m³ planned** with **65 m³ signed**, inspect report **R10**, then export the daily site report. |
| Approver | `approver@riverside.example` | After the manager submits a notice, review its evidence, request changes or approve it, then download the PDF or Word version. |

### 4. Optional: voice notes

To dictate a note, run the local Whisper speech-to-text server in another terminal. The first start downloads the English speech model.

**macOS · Terminal**

```sh
cd backend/whisper-server
python3.12 -m venv .venv
./.venv/bin/python -m pip install -r requirements.txt
./.venv/bin/python server.py
```

**Windows · PowerShell**

```powershell
cd backend/whisper-server
py -3.12 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe server.py
```

When <http://127.0.0.1:8001/health> says `ok`, set `WHISPER_BASE_URL=http://127.0.0.1:8001/v1` in `backend/.env` and `NEXT_PUBLIC_VOICE_TRANSCRIPTION=true` in `frontend/.env.local`, restart both, and allow microphone access when asked. Typed notes work without this step.

## Android phone

<details>
<summary>Show the Android steps</summary>

The repository includes an Android app (built with Capacitor) that works from Windows or macOS. Install Android Studio, Android SDK Platform **36**, Platform-Tools and **JDK 21**. In Android Studio, select JDK 21 for Gradle. For command-line builds, set `JAVA_HOME` to that JDK and `ANDROID_HOME` to the SDK folder shown in the SDK Manager.

1. Start the web app on port 3000. For role sign-in, also start the API.
2. On the phone, turn on **Developer options → USB debugging**, connect it by USB and accept the prompt. An emulator works too.
3. From the repository root:

**macOS · Terminal**

```sh
cd frontend
npx cap sync android
adb="$HOME/Library/Android/sdk/platform-tools/adb"
"$adb" devices
"$adb" reverse tcp:3000 tcp:3000
npx cap open android
```

**Windows · PowerShell**

```powershell
cd frontend
npx.cmd cap sync android
$adb = "$env:LOCALAPPDATA\Android\Sdk\platform-tools\adb.exe"
& $adb devices
& $adb reverse tcp:3000 tcp:3000
npx.cmd cap open android
```

In Android Studio pick the device and press **Run ▶**. If the app shows **Connect to SiteMate**, make sure the device is listed as `device`, the web app opens on the laptop, repeat the `adb reverse` command and tap **Try again**.

To launch straight from the terminal, run `npx cap run android --forwardPorts 3000:3000` (macOS) or `npx.cmd cap run android --forwardPorts 3000:3000` (Windows) from `frontend`.

</details>

## How the project is organised

| Folder | What is inside | More detail |
| --- | --- | --- |
| [frontend/](frontend/) | The web and mobile screens (Next.js, TypeScript). Shows results; never calculates them. | [frontend/README.md](frontend/README.md) |
| [backend/](backend/) | The API and all calculations: progress, deviations, performance, notices, exports, sign-in. | [backend/README.md](backend/README.md) |
| [backend/performance/](backend/performance/) | Baseline upload, daily evaluation, overall evaluation, merits and demerits. | [plan/performance-evaluation-plan.md](plan/performance-evaluation-plan.md) |
| [backend/documents/](backend/documents/) | Reads reports, emails, minutes and photos into cited passages; summaries and search. | [backend/README.md](backend/README.md) |
| [ai-agent/](ai-agent/) | The incident agent that finds probable causes and scores its confidence. | [ai-agent/README.md](ai-agent/README.md) |
| [mock_data/](mock_data/) | The five fictional plan PDFs for Riverside Residences - Block B. | see above |
| [data/](data/) | Demo records: registers, reports, emails, minutes, diary, voice transcripts. | `data/riverside-demo/README.txt` |
| [plan/](plan/) | Architecture diagram and design notes. | [plan/](plan/) |
| `Problem_Statement.txt` | The original challenge this project answers. | |

## Glossary

| Term | Plain meaning |
| --- | --- |
| **Baseline / programme** | The approved plan: what should be built, when, and in what quantities. |
| **Activity** | One job in the plan, such as "Raft foundation" (code `A300`). |
| **Target per day** | How much of an activity should be finished each working day. |
| **Signed quantity** | The amount the site supervisor signed off in a daily report. It beats any estimate. |
| **Deviation / shortfall** | Output below target. Amber means slightly behind, red means seriously behind. |
| **SPI** | Schedule Performance Index. 1.0 is on plan, below 1.0 is behind. |
| **S-curve** | A chart of planned versus actual cumulative progress over time. |
| **Delay notice** | A formal letter telling the client that something outside the contractor's control is delaying the work. It has contract deadlines. |
| **Merit / demerit** | A day that beat the plan, or one that fell short, recorded with its evidence and who caused it. |
| **As-of clock** | A date and time you choose so the app shows only what was known then. |

## Troubleshooting

| What you see | What to do |
| --- | --- |
| `EMAXCONNSESSION: max clients reached in session mode` | The Supabase session pooler allows only a small number of connections (15 on the free plan). Stop stray API, worker or script processes (for example `pkill -f uvicorn`), then start one copy of each. |
| The app shows demo records but sign-in fails | You are in preview mode. Follow [Full setup](#full-setup-live-data) and set `NEXT_PUBLIC_USE_FIXTURES=false`. |
| Changes to `.env.local` have no effect | Restart the web app. |
| AI features return errors | Check `ANTHROPIC_API_KEY` in `backend/.env`. |
| Microphone button does nothing | Start Whisper (step 4) and turn on `NEXT_PUBLIC_VOICE_TRANSCRIPTION`. |
| `Could not upload ... SSL: CERTIFICATE_VERIFY_FAILED` on macOS | Run the script with `SSL_CERT_FILE` set to the path printed by `python -c "import certifi; print(certifi.where())"`. |

## Running the tests

```sh
cd backend && ./.venv/bin/python -m pytest -q tests      # API and performance logic
cd ai-agent && python -m pytest -q tests                 # incident agent (no database or API key needed)
cd frontend && npm run lint && npm run typecheck         # web app checks
```

## Good to know

- All project data is fictional. No real company documents, notices or messages are used or sent.
- SiteMate supports drafting only. It gives no legal advice, and the final review always belongs to the site manager and the company.
