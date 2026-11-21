/* eslint-disable @typescript-eslint/no-require-imports -- This standalone check can use an external Playwright installation. */
// Run against the local demo. Supply a JSON array of the three role passwords on stdin
// (foreman, manager, approver). PLAYWRIGHT_MODULE may point to an installed Playwright.
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const root = "http://localhost:3000";
const roles = ["foreman", "manager", "approver"];
const pass = JSON.parse(readFileSync(0, "utf8"));
const button = (page, name) => page.getByRole("button", { name, exact: typeof name === "string" });
const fulfill = (route, json, status = 200) => route.fulfill({ status, json });
async function login(browser, role) {
  const context = await browser.newContext({
    baseURL: root,
    permissions: ["microphone"],
    viewport: { width: 414, height: 880 },
  });
  await context.route("**/api/sm/**", (route) => {
    if (route.request().method() === "GET") return route.continue();
    return route.abort("blockedbyclient");
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  await page.goto("/login");
  await page.locator("#email").fill(role + "@riverside.example");
  await page.locator("#password").fill(pass[roles.indexOf(role)]);
  await button(page, "Sign in").click();
  await page.waitForURL("**/" + role, { timeout: 30000 });
  const me = await context.request.get("/api/auth/me");
  assert.equal(me.status(), 200);
  const member = (await me.json()).memberships.find((m) => m.project_id === "RIV");
  const paths = role === "foreman" ? ["field-notes?mine=true", "captures"] : ["drafts"];
  for (const path of paths) {
    const r = await context.request.get("/api/sm/projects/RIV/" + path);
    assert.equal(r.status(), 200);
    const json = await r.json();
    const count = Array.isArray(json)
      ? json.length
      : json.recordings.filter((n) => n.author === member.member_id).length;
    console.log(role, path, "live records:", count);
  }
  if (role === "foreman") {
    await page.goto("/foreman/reports");
    const reports = page.locator('section[aria-labelledby="recent-title"] li');
    const saved = await (await context.request.get("/api/sm/projects/RIV/captures")).json();
    const field = await (await context.request.get("/api/sm/projects/RIV/field-notes?mine=true")).json();
    const expected = saved.recordings.filter((n) => n.author === member.member_id).length + field.length;
    if (expected) await reports.nth(expected - 1).waitFor();
    assert.equal(await reports.count(), expected);
    console.log("My reports lists", expected, "live entries");
  }
  return { context, page, member };
}
async function testCapture({ context, page, member }) {
  const note = "QA concrete delivery, 12 cubic metres";
  const thread = "qa-capture";
  const event = { summary: note, category: "progress", event_type: "production" };
  const result = { thread_id: thread, transcript: note, events: [event] };
  const stored = [];
  const submissions = [];
  let round = 0;
  const question = () => ({
    ...result,
    status: "needs_input",
    round: ++round,
    questions: [{ id: "same-id", field_name: "zone", question: "Where was the delivery?" }],
  });
  await context.route("**/api/sm/projects/RIV/captures**", async (route) => {
    const req = route.request(),
      path = new URL(req.url()).pathname;
    if (req.method() === "GET") return fulfill(route, { recordings: stored });
    if (path.endsWith("/captures")) {
      const form = await new Response(req.postDataBuffer(), {
        headers: { "Content-Type": req.headers()["content-type"] },
      }).formData();
      const submission = {
        text: form.get("transcript"),
        audio: form.get("audio")?.size || 0,
        images: form.getAll("images").length,
      };
      submissions.push(submission);
      if (submissions.length === 1) return fulfill(route, { detail: "Temporary QA error" }, 502);
      if (submission.audio) return fulfill(route, { status: "no_events", transcript: "QA audio" });
      return fulfill(
        route,
        {
          ...result,
          status: "needs_category",
          capture_id: thread,
          photo_descriptions: [],
          events: [
            {
              index: 0,
              summary: note,
              suggested_category: "progress",
              suggested_event_type: "production",
              confidence: 0.9,
              rationale: "QA",
              alternatives: [],
            },
          ],
        },
        202,
      );
    }
    if (path.endsWith("/categories")) return fulfill(route, question(), 202);
    if (path.endsWith("/answers"))
      return fulfill(
        route,
        round === 1 ? question() : {
          ...result, status: "needs_review", gaps: [],
          facts: [
            { index: 0, event_index: 0, field_name: "description", value: note.repeat(8), basis: "reported" },
            { index: 1, event_index: 0, field_name: "occurred_at", value: new Date().toISOString(), basis: "reported" },
          ],
        },
        202,
      );
    assert.ok(path.endsWith("/review"));
    stored.push({
      id: "CAP-QATEST",
      recorded_at: new Date().toISOString(),
      author: member.member_id,
      author_role: "foreman",
      transcript: note,
      has_audio: false,
      answers: [],
      facts: [],
      incidents: [],
    });
    return fulfill(
      route,
      {
        ...result,
        status: "saved",
        source_id: "CAP-QATEST",
        facts: [],
        gaps: [],
        incident_ids: {},
        incident_links: [],
      },
      201,
    );
  });
  await page.goto("/capture");
  await button(page, "Type instead").click();
  await page.locator("#note-text").fill(note);
  await page
    .locator("input[type=file][multiple]")
    .setInputFiles({
      name: "demo.png",
      mimeType: "image/png",
      buffer: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jWZkAAAAASUVORK5CYII=",
        "base64",
      ),
    });
  await button(page, "Send note").click();
  await page.getByText("Temporary QA error").waitFor();
  assert.equal(await page.locator("#note-text").inputValue(), note);
  assert.equal(await page.locator('ul[aria-label="Attached photos"] img').count(), 1);
  await button(page, /retry|try again/i)
    .first()
    .click();
  await button(page, "Confirm 1 event").waitFor();
  assert.equal(await page.locator('ul[aria-label="Attached photos"] img').count(), 0);
  await button(page, "Confirm 1 event").click();
  await page.getByLabel("Where was the delivery?").fill("B");
  await button(page, "Submit answers").click();
  await page.getByText(/round 2/).waitFor();
  assert.equal(await page.getByLabel("Where was the delivery?").inputValue(), "");
  await button(page, "Submit answers").click();
  await button(page, "Remove description").waitFor();
  for (const width of [320, 390, 768]) {
    await page.setViewportSize({ width, height: 844 });
    const remove = await button(page, "Remove occurred at").boundingBox();
    assert.ok(remove && remove.x >= 0 && remove.x + remove.width <= width);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  }
  await page.setViewportSize({ width: 414, height: 880 });
  await button(page, "Remove description").click();
  await button(page, "Keep description").click();
  await button(page, "Save to project").click();
  await page.getByText("Saved to the project. Ready for your next note.").waitFor();
  assert.equal(await page.locator('[aria-label="Progress"] [aria-current=step]').count(), 0);
  await button(page, "Type instead").click();
  assert.equal(await page.locator("#note-text").inputValue(), "");
  await page.locator("#note-text").fill("Typed draft must not replace speech");
  await button(page, "Start recording").click();
  await button(page, "Stop recording").waitFor();
  await page.waitForTimeout(850);
  await button(page, "Stop recording").click();
  await button(page, "Send recording").click();
  await page.getByText("No site events found in that note").waitFor();
  assert.equal(submissions.length, 3);
  assert.deepEqual(submissions[0], submissions[1]);
  assert.equal(submissions[0].images, 1);
  assert.equal(submissions[0].text, note);
  assert.ok(submissions[2].audio > 0);
  assert.equal(submissions[2].text, null);
  assert.equal(submissions[2].images, 0);
  await page.goto("/foreman/reports");
  await page.getByText("“" + note + "”").waitFor();
  console.log("Passed foreman photo/text, retry, review, reset, voice-only payload and My reports");
}

async function testFieldReport({ context, page }) {
  let report;
  await context.route("**/api/sm/projects/RIV/field-notes**", async (route) => {
    const req = route.request();
    if (req.method() === "GET") return fulfill(route, report ? [report] : []);
    if (new URL(req.url()).pathname.endsWith("/confirm")) {
      report.status = "confirmed";
      report.confirmed_by = "QA foreman";
      report.confirmed_at = report.recorded_at;
    } else {
      report = {
        source_id: "FN-QATEST",
        text: req.postDataJSON().text,
        recorded_at: new Date().toISOString(),
        author: "QA foreman",
        status: "proposed",
        confirmed_by: null,
        confirmed_at: null,
        facts: [],
      };
    }
    return fulfill(route, report);
  });
  await page.goto("/foreman");
  await page.locator("#note-text").fill("QA field report");
  await button(page, "Record note").click();
  await button(page, "Confirm").click();
  await page.getByRole("status").filter({ hasText: "FN-QATEST" }).waitFor();
  assert.equal(await page.locator("#note-text").inputValue(), "");
  await page.getByRole("link", { name: "View My reports" }).click();
  await page.getByText("“QA field report”").waitFor();
  console.log("Passed foreman field-report confirmation, reset and report history");
}

async function testNotice(manager, approver) {
  const when = "2026-11-10T17:30:00+01:00",
    code = "QA-B",
    name = "QA foundations";
  const ref = { source_id: "SCH", locator: code, passage_id: "SCH:" + code };
  const activity = {
    code,
    name,
    unit: "m³",
    zone: "B",
    contractor: null,
    planned: 30,
    plan_ref: ref,
    actual: 10,
    actual_ref: null,
    reported_at: when,
    estimate: null,
    shortfall_pct: 67,
    severity: "high",
    status: "behind",
    equipment: [],
    notes: { total: 0, confirmed: 0 },
    alert_id: "qa-alert",
    notice: null,
  };
  const versions = [];
  const notice = () => ({
    id: "qa-notice",
    notice_type: "delay",
    alert_id: "qa-alert",
    activity_code: code,
    activity_name: name,
    status: versions.at(-1)?.review?.decision || "awaiting_review",
    latest: versions.at(-1),
    versions,
  });
  const transitions = [];
  for (const [client, role] of [
    [manager, "manager"],
    [approver, "approver"],
  ]) {
    await client.context.route("**/api/sm/projects/RIV/site-day?**", (r) =>
      fulfill(r, {
        date: "2026-11-10",
        timezone: "Europe/Berlin",
        threshold: 10,
        high_threshold: 30,
        first_day: "2026-11-10",
        last_day: "2026-11-10",
        activities: [activity],
      }),
    );
    await client.context.route("**/api/sm/projects/RIV/drafts**", async (r) => {
      const req = r.request(),
        path = new URL(req.url()).pathname;
      if (req.method() === "GET") return fulfill(r, versions.length ? [notice()] : []);
      const body = req.postDataJSON();
      if (path.endsWith("/review")) {
        assert.equal(role, "approver");
        assert.ok(path.endsWith("/versions/" + versions.length + "/review"));
        versions.at(-1).review = {
          decision: body.decision,
          reason: body.reason ?? null,
          decided_at: when,
          reviewer: "QA approver",
        };
        transitions.push(body.decision);
      } else {
        assert.equal(role, "manager");
        const v = versions.length + 1;
        if (v === 2) {
          assert.equal(body.expected_version, 1);
          assert.equal(body.contract_reference, "QA contract");
          assert.equal(body.contract_clause, "QA clause");
        }
        versions.push({
          version: v,
          as_of: when,
          body: "QA notice version " + v,
          evidence_refs: [],
          missing_fields: v === 1 ? ["contract reference", "contract clause"] : [],
          review: null,
        });
        transitions.push("version " + v);
      }
      return fulfill(r, notice());
    });
  }
  const m = manager.page,
    a = approver.page;
  await m.goto("/manager");
  await button(m, "Draft & send for review").click();
  await m.getByText(/Delay notice · version 1/).waitFor();
  await a.goto("/approver");
  await button(a, "Request changes").waitFor();
  assert.equal(await button(a, "Approve version 1").isDisabled(), true);
  await button(a, "Request changes").click();
  await a.getByLabel("What needs to change?").fill("Cancelled draft");
  await button(a, "Cancel").click();
  await button(a, "Request changes").click();
  assert.equal(await a.getByLabel("What needs to change?").inputValue(), "");
  await a.getByLabel("What needs to change?").fill("Please add the contract details");
  await button(a, "Send back to site manager").click();
  await m.getByLabel("Revise notice").waitFor();
  await m.getByLabel("contract reference", { exact: true }).fill("QA contract");
  await m.getByLabel("contract clause", { exact: true }).fill("QA clause");
  await button(m, "Submit version 2 for approval").click();
  await button(a, "Approve version 2").click();
  await a.getByRole("link", { name: "Download PDF" }).waitFor();
  await m.getByRole("link", { name: "Download Word" }).waitFor();
  assert.deepEqual(transitions, ["version 1", "changes_requested", "version 2", "approved"]);
  console.log(
    "Passed manager to approver, missing-field gate, cancelled reason, revision, approval, export controls",
  );
}

(async () => {
  const browser = await chromium.launch({
    channel: "chrome",
    headless: true,
    args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"],
  });
  const users = {};
  try {
    for (const role of roles) users[role] = await login(browser, role);
    await testCapture(users.foreman);
    await testFieldReport(users.foreman);
    await testNotice(users.manager, users.approver);
  } finally {
    await Promise.allSettled(
      Object.values(users).map((user) => user.context.request.post("/api/auth/logout")),
    );
    await browser.close();
  }
})().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
