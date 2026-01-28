import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import pg from "pg";
import speechsdk from "microsoft-cognitiveservices-speech-sdk";


dotenv.config();

const { Pool } = pg;
const app = express();

app.use(cors());
app.use(express.json({ limit: "15mb" }));

if (!process.env.DATABASE_URL) {
  throw new Error("Missing DATABASE_URL in .env");
}
if (!process.env.API_KEY) {
  throw new Error("Missing API_KEY in .env");
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // ssl: { rejectUnauthorized: false },
});

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

app.post("/azure-pron-score", requireApiKey, async (req, res) => {
  try {
    const { expectedText, audioWavBase64, language = "ja-JP" } = req.body ?? {};
    if (!expectedText || !audioWavBase64) {
      return res.status(400).json({ ok: false, error: "expectedText and audioWavBase64 are required" });
    }
    if (!process.env.AZURE_SPEECH_KEY || !process.env.AZURE_SPEECH_REGION) {
      return res.status(500).json({ ok: false, error: "Missing AZURE_SPEECH_KEY / AZURE_SPEECH_REGION" });
    }

    const wavBytes = Buffer.from(audioWavBase64, "base64");

    const speechConfig = speechsdk.SpeechConfig.fromSubscription(
      process.env.AZURE_SPEECH_KEY,
      process.env.AZURE_SPEECH_REGION
    );
    speechConfig.speechRecognitionLanguage = language;

    const audioConfig = speechsdk.AudioConfig.fromWavFileInput(wavBytes);
    const recognizer = new speechsdk.SpeechRecognizer(speechConfig, audioConfig);

    // Reference text = expected text
    const paConfig = new speechsdk.PronunciationAssessmentConfig(
      expectedText,
      speechsdk.PronunciationAssessmentGradingSystem.HundredMark,
      speechsdk.PronunciationAssessmentGranularity.Phoneme,
      true // enable miscue
    );
    paConfig.applyTo(recognizer);

    recognizer.recognizeOnceAsync(
      (result) => {
        try {
          const recognizedText = result.text || "";
          const pa = speechsdk.PronunciationAssessmentResult.fromResult(result);

          res.json({
            ok: true,
            recognizedText,
            accuracyScore: pa.accuracyScore,
            fluencyScore: pa.fluencyScore,
            completenessScore: pa.completenessScore,
            pronunciationScore: pa.pronunciationScore,
          });
        } finally {
          recognizer.close();
        }
      },
      (err) => {
        recognizer.close();
        res.status(500).json({ ok: false, error: String(err) });
      }
    );
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

      // ✅ NEW: final recognized text from Unity
      recognizedText = null,
    } = req.body ?? {};

    // ✅ Debug: confirm backend receives it
    console.log("ROUND SCORE BODY:", {
      userId,
      sessionId,
      roundIndex,
      score,
      confidence,
      passed,
      recognizedText,
      meta,
    });

    if (typeof userId !== "string" || userId.trim().length === 0) {
      return res.status(400).json({ error: "userId is required" });
    }
    if (!Number.isInteger(roundIndex)) {
      return res.status(400).json({ error: "roundIndex must be an integer" });
    }

    const result = await pool.query(
      `insert into round_scores (
         user_id,
         session_id,
         round_index,
         score,
         confidence,
         passed,
         meta,
         recognized_text
       )
       values ($1,$2,$3,$4,$5,$6,$7,$8)
       returning id, created_at`,
      [userId, sessionId, roundIndex, score, confidence, passed, meta, recognizedText]
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
