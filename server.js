const express = require("express");
const path = require("path");
const { execFile } = require("child_process");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const CLAUDE_MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-5";
const CLAUDE_TIMEOUT_MS = Number(process.env.CLAUDE_TIMEOUT_MS || 120000);

// sessionId (browser) -> claude session_id (returned by the CLI, used for --resume)
const sessions = new Map();

function runClaude(message, claudeSessionId) {
  const args = ["-p", "--output-format", "json", "--model", CLAUDE_MODEL];
  if (claudeSessionId) {
    args.push("--resume", claudeSessionId);
  }
  args.push(message);

  return new Promise((resolve, reject) => {
    execFile(
      "claude",
      args,
      { timeout: CLAUDE_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          if (err.killed) {
            return reject(new Error("claude did not respond in time"));
          }
          return reject(new Error(stderr || err.message));
        }
        try {
          const data = JSON.parse(stdout);
          resolve(data);
        } catch (parseErr) {
          reject(new Error(`Failed to parse claude output: ${stdout.slice(0, 500)}`));
        }
      }
    );
  });
}

app.post("/api/chat", async (req, res) => {
  const { sessionId, message } = req.body;
  if (!sessionId || !message) {
    return res.status(400).json({ error: "sessionId and message are required" });
  }

  try {
    const claudeSessionId = sessions.get(sessionId);
    const data = await runClaude(message, claudeSessionId);

    if (data.is_error) {
      return res.status(502).json({ error: data.result || "claude returned an error" });
    }

    sessions.set(sessionId, data.session_id);
    res.json({ reply: data.result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3100;
app.listen(PORT, () => {
  console.log(`Chat server running on http://localhost:${PORT}`);
});
