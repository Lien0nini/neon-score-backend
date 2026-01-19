import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import pg from "pg";

dotenv.config();

const { Pool } = pg;
const app = express();

app.use(cors());
app.use(express.json({ limit: "200kb" }));

if (!process.env.DATABASE_URL) {
  throw new Error("Missing DATABASE_URL in .env");
}
if (!process.env.API_KEY) {
  throw new Error("Missing API_KEY in .env");
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Neon uses TLS; sslmode=require in the URL is usually enough.
  // If your host needs it explicitly, uncomment:
  // ssl: { rejectUnauthorized: false },
});

// Simple API-key auth (good enough for dev; prevents random public spam)
function requireApiKey(req, res, next) {
  const key = req.header("x-api-key");
  if (!key || key !== process.env.API_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

app.get("/health", async (req, res) => {
  try {
    const r = await pool.query("select 1 as ok");
    res.json({ ok: true, db: r.rows[0].ok === 1 });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message ?? e) });
  }
});

app.post("/round-score", requireApiKey, async (req, res) => {
  try {
    const {
      userId,
      sessionId = null,
      roundIndex,
      score = null,
      confidence = null,
      passed = null,
      meta = null,
    } = req.body ?? {};

    if (typeof userId !== "string" || userId.trim().length === 0) {
      return res.status(400).json({ error: "userId is required" });
    }
    if (!Number.isInteger(roundIndex)) {
      return res.status(400).json({ error: "roundIndex must be an integer" });
    }

    const result = await pool.query(
      `insert into round_scores (user_id, session_id, round_index, score, confidence, passed, meta)
       values ($1,$2,$3,$4,$5,$6,$7)
       returning id, created_at`,
      [userId, sessionId, roundIndex, score, confidence, passed, meta]
    );

    res.json({ ok: true, ...result.rows[0] });
  } catch (e) {
    console.error("Insert failed:", e);
    res.status(500).json({ ok: false, error: String(e?.message ?? e) });
  }
});

app.listen(process.env.PORT || 3000, () => {
  console.log(`API listening on port ${process.env.PORT || 3000}`);
});
