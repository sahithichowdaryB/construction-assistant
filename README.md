# SiteMate

SiteMate helps a construction team turn a field report into a decision it can trace back to the evidence. In the Riverside Office Block demo, an excavator breaks down in Zone B. The foreman records what happened, the site manager checks the signed quantity against the plan, and an approver reviews the resulting notice before export.

| What you want to try | Where to start |
| --- | --- |
| Browse the Riverside project in a browser, without an account | [Browser preview](#browser-preview) |
| Sign in as each role, save reports and export documents | [Full project with live data](#full-project-with-live-data) |
| Run the app on an Android phone from Windows or macOS | [Android with Capacitor](#android-with-capacitor) |

## Browser preview

Install **Node.js 24** with npm. Clone the repository on either platform, or open the root of an existing checkout.

```sh
git clone https://github.com/sahithichowdaryB/construction-assistant.git
cd construction-assistant
```

**Windows · PowerShell**

```powershell
cd frontend
npm.cmd ci
if (!(Test-Path .env.local)) { Copy-Item .env.example .env.local }
npm.cmd run dev -- --port 3000
```

**macOS · Terminal**

```sh
cd frontend
npm ci
cp -n .env.example .env.local
npm run dev -- --port 3000
```

Open the [Riverside dashboard](http://localhost:3000/today). The example configuration sets `NEXT_PUBLIC_USE_FIXTURES=true`, which lets you browse the included project records without a database or API key. Set the header clock to **10 Nov 17:30**, then open **Documents** and find the signed 10 November report. Sign-in, persisted captures and generated exports use the live setup below.

## Full project with live data

The Next.js frontend on port `3000` forwards requests to FastAPI on port `8000`. PostgreSQL stores project records and sessions. Whisper transcribes speech, and Claude helps extract facts and draft correspondence. The signed quantities and shortfalls are calculated in code.

### 1. Install the backend

Use **Python 3.12**. In a new terminal at the repository root, run the block for your platform. The file-copy commands preserve an existing configuration.

**Windows · PowerShell**

```powershell
cd backend
py -3.12 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
if (!(Test-Path .env)) { Copy-Item .env.example .env }
```

**macOS · Terminal**

```sh
cd backend
python3.12 -m venv .venv
./.venv/bin/python -m pip install -r requirements.txt
cp -n .env.example .env
```

### 2. Connect and seed the database

**Using an existing team database?** Use its provisioned `backend/.env` and the demo credentials supplied by the team. Continue with step 3.

**Setting up your own database?** Create a Supabase project with Auth enabled. In the project’s **Connect** panel, choose the **Session pooler** connection on port `5432`. Copy its host, project reference and database name into the URL templates in `backend/.env`. Keep the `postgresql+psycopg://` prefix and URL-encode special characters in passwords. [Supabase connection guide](https://supabase.com/docs/guides/database/connecting-to-postgres) · [Backend environment template](backend/.env.example)

| Setting in `backend/.env` | Value |
| --- | --- |
| `MIGRATION_DATABASE_URL` | Admin connection for migrations and seeding, using the project database password. |
| `DATABASE_URL` | Connection for `sitemate_reader`. Choose a password for this role. |
| `AGENT_DATABASE_URL` | Connection for `sitemate_agent`, which writes field captures. Choose a separate password. |
| `OPS_DATABASE_URL` | Connection for `sitemate_ops`, which handles manager actions and background jobs. Choose a separate password. |
| `RIVERSIDE_DEMO_TOKEN` | Run `node -p "require('node:crypto').randomBytes(32).toString('hex')"` on either platform and paste the result here. |
| `ANTHROPIC_API_KEY` | Needed for model-backed features such as capture classification, summaries and drafting. You can browse seeded records and check quantities without it. |

From `backend`, run these commands once for the new database. The provisioning scripts create the three database roles using the passwords you chose. The last command prints a password for each newly created app account. Save those passwords for sign-in.

**Windows · PowerShell**

```powershell
.\.venv\Scripts\python.exe -m alembic upgrade head
.\.venv\Scripts\python.exe provision_reader.py
.\.venv\Scripts\python.exe provision_agent.py
.\.venv\Scripts\python.exe provision_ops.py
.\.venv\Scripts\python.exe seed_riverside.py
.\.venv\Scripts\python.exe seed_demo_users.py
```

**macOS · Terminal**

```sh
./.venv/bin/python -m alembic upgrade head
./.venv/bin/python provision_reader.py
./.venv/bin/python provision_agent.py
./.venv/bin/python provision_ops.py
./.venv/bin/python seed_riverside.py
./.venv/bin/python seed_demo_users.py
```

### 3. Start the live app

In `frontend/.env.local`, set the values below. If this is your first frontend run, install the frontend dependencies and copy its environment template using the browser preview steps above.

```dotenv
NEXT_PUBLIC_USE_FIXTURES=false
SITEMATE_API_URL=http://127.0.0.1:8000
```

Keep the API and frontend running in separate terminals. Restart the frontend after changing its environment.

| Process and working directory | Windows PowerShell | macOS Terminal |
| --- | --- | --- |
| API · `backend` | `.\.venv\Scripts\python.exe -m uvicorn main:app --host 127.0.0.1 --port 8000` | `./.venv/bin/python -m uvicorn main:app --host 127.0.0.1 --port 8000` |
| Web app · `frontend` | `npm.cmd run dev -- --port 3000` | `npm run dev -- --port 3000` |
| Background incident processing · `backend`, when exercising the worker | `.\.venv\Scripts\python.exe worker.py` | `./.venv/bin/python worker.py` |

Check the [database health endpoint](http://127.0.0.1:8000/health/db), then [sign in to SiteMate](http://localhost:3000/login). Use the password issued for your database.

| Role | Demo email | What to try |
| --- | --- | --- |
| Foreman | `foreman@riverside.example` | Open **Report a problem**, enter a field note and review the extracted facts. |
| Site manager | `manager@riverside.example` | Open the [Zone B replay](http://localhost:3000/manager?as_of=2026-11-10T17%3A30%3A00%2B01%3A00). Compare **100 m³ planned** with **65 m³ signed**, inspect report **R10**, then export the daily site report. |
| Approver | `approver@riverside.example` | After the manager submits a notice, review its evidence, request changes or approve it. Download the approved version as PDF or Word. |

### 4. Enable microphone transcription

To record a voice note, start local Whisper in another terminal from the repository root. The first launch downloads the English speech model.

**Windows · PowerShell**

```powershell
cd backend/whisper-server
py -3.12 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe server.py
```

**macOS · Terminal**

```sh
cd backend/whisper-server
python3.12 -m venv .venv
./.venv/bin/python -m pip install -r requirements.txt
./.venv/bin/python server.py
```

Once [Whisper health](http://127.0.0.1:8001/health) reports `ok`, set `WHISPER_BASE_URL=http://127.0.0.1:8001/v1` in `backend/.env` and `NEXT_PUBLIC_VOICE_TRANSCRIPTION=true` in `frontend/.env.local`. Restart FastAPI and Next.js, then allow microphone access when prompted. Typed notes skip this step.

## Android with Capacitor

The included native project targets **Android** and can be launched from either Windows or macOS. Install Android Studio, Android SDK Platform **36**, SDK Platform-Tools and **JDK 21**. In Android Studio, select JDK 21 for Gradle. For command-line builds, set `JAVA_HOME` to that JDK and `ANDROID_HOME` to the SDK location shown in Android Studio’s SDK Manager.

1. Start the web app on port **3000**. For role sign-in, also start the live API.
2. On the phone, enable **Developer options → USB debugging**, connect it by USB and accept the debugging prompt. An Android Studio emulator also works with the same port mapping.
3. Open a new terminal at the repository root. Run the block for your computer. If you installed the SDK in a custom location, use that SDK’s `platform-tools/adb` path.

**Windows · PowerShell**

```powershell
cd frontend
npx.cmd cap sync android
$adb = "$env:LOCALAPPDATA\Android\Sdk\platform-tools\adb.exe"
& $adb devices
& $adb reverse tcp:3000 tcp:3000
npx.cmd cap open android
```

**macOS · Terminal**

```sh
cd frontend
npx cap sync android
adb="$HOME/Library/Android/sdk/platform-tools/adb"
"$adb" devices
"$adb" reverse tcp:3000 tcp:3000
npx cap open android
```

In Android Studio, select the phone or running emulator and click **Run ▶** with the debug build. The app loads the laptop’s SiteMate server through USB. If it shows **Connect to SiteMate**, check that the device is listed as `device`, confirm the web app opens on the laptop, repeat the `adb reverse` command and tap **Try again**.

**Launch directly from the terminal.** From `frontend`, run `npx cap run android --forwardPorts 3000:3000` on macOS or `npx.cmd cap run android --forwardPorts 3000:3000` on Windows. This syncs, builds and installs the debug app on the selected device. [Capacitor open command](https://capacitorjs.com/docs/cli/commands/open) · [Capacitor run command](https://capacitorjs.com/docs/cli/commands/run)
