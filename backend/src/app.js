import express from "express";
import { config } from "./config.js";
import { pool } from "./database/pool.js";
import { captures } from "./routes/captures.js";
import { categories } from "./routes/categories.js";

export const app = express();
app.use(express.json({ limit: "1mb" }));
app.use((req, res, next) => {
  const origin = req.get("origin");
  if (origin && config.allowedOrigins.includes(origin)) {
    res.set({ "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Headers": "Authorization, Content-Type",
      "Access-Control-Allow-Methods": "POST, GET", Vary: "Origin" });
  }
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.get("/health", async (_req, res) => {
  await pool.query("SELECT 1");
  res.json({ database: "connected" });
});
app.use("/projects/:projectId/captures", captures);
app.use("/projects/:projectId/event-categories", categories);

app.use((err, _req, res, _next) => {
  if (!err.expose) console.error(err);
  if (err.name === "MulterError") return res.status(422).json({ detail: `Upload rejected: ${err.message}` });
  res.status(err.expose ? (err.status ?? 500) : 500).json({ detail: err.expose ? err.message : "Capture failed" });
});

if (import.meta.url === `file://${process.argv[1]}`) {
  app.listen(config.port, () => console.log(`SiteMate capture agent on :${config.port}`));
}
