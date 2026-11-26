require("dotenv").config();
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const cors = require("cors");
const express = require("express");
const { JSDOM } = require("jsdom");
const { Readability } = require("@mozilla/readability");
const crypto = require("crypto");
const { Pool } = require("pg");
const cron = require("node-cron");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
});
const app = express();
app.use(express.json());
app.use(cors());
function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.replace("Bearer ", "");
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.userId = payload.userId;
    next();
  } catch (err) {
    res.status(401).json({ error: "Please log in" });
  }
}

app.get("/health", (req, res) => res.json({ ok: true }));

// SAVE a page
app.post("/pages", requireAuth, async (req, res) => {
  const { url } = req.body;

  try {
    const response = await fetch(url);
    const html = await response.text();

    const dom = new JSDOM(html, { url });
    const article = new Readability(dom.window.document).parse();

    const text = (article?.textContent ?? "").replace(/\s+/g, " ").trim();
    const hash = crypto.createHash("sha256").update(text).digest("hex");

    await pool.query(
      "INSERT INTO pages (url, title, content, content_hash, user_id) VALUES ($1, $2, $3, $4, $5)",
      [url, article?.title, text, hash, req.userId]
    );

    res.json({ saved: true, title: article?.title, hash });
  } catch (err) {
    console.log(err);
    res.status(400).json({ error: "Could not save that URL" });
  }
});

// LIST pages
app.get("/pages", requireAuth, async (req, res) => {
  const result = await pool.query(
    "SELECT id, url, title, status, saved_at FROM pages WHERE user_id = $1 ORDER BY saved_at DESC",
    [req.userId]
  );
  res.json(result.rows);
});

// SEARCH pages
app.get("/search", requireAuth, async (req, res) => {
  const q = req.query.q;
  const result = await pool.query(
    "SELECT id, url, title FROM pages WHERE user_id = $2 AND to_tsvector('english', content) @@ plainto_tsquery('english', $1)",
    [q, req.userId]
  );
  res.json(result.rows);
});

app.post("/signup", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: "Email and password required" });
  }
  try {
    const password_hash = await bcrypt.hash(password, 10);
    await pool.query(
      "INSERT INTO users (email, password_hash) VALUES ($1, $2)",
      [email, password_hash]
    );
    res.json({ signedUp: true });
  } catch (err) {
    res.status(400).json({ error: "Email already used" });
  }
});

app.post("/login", async(req, res)=> {
  const { email, password } = req.body;
  const { rows } = await pool.query("SELECT*FROM users WHERE email = $1", [email]);
  const user = rows[0];
  if (!user || !(await bcrypt.compare (password, user.password_hash))) {
    return res.status(401).json({error: "Wrong email or password"});
  }
  const token = jwt.sign({userId: user.id}, process.env. JWT_SECRET, {expiresIn: "7d"});
  res.json({ token });
});



// RE-CHECK helpers
async function getPageText(url) {
  const response = await fetch(url);
  if (response.status === 404 || response.status === 410) {
    return { gone: true };
  }
  const html = await response.text();
  const dom = new JSDOM(html, { url });
  const article = new Readability(dom.window.document).parse();
  const text = (article?.textContent ?? "").replace(/\s+/g, " ").trim();
  const hash = crypto.createHash("sha256").update(text).digest("hex");
  return { hash };
}

async function recheckPage(page) {
  let status;
  try {
    const result = await getPageText(page.url);
    if (result.gone) status = "gone";
    else status = result.hash === page.content_hash ? "ok" : "changed";
  } catch (err) {
    status = "unreachable";
  }
  await pool.query("UPDATE pages SET status = $1 WHERE id = $2", [status, page.id]);
  return status;
}

app.post("/recheck/:id", requireAuth, async (req, res) => {
  const { rows } = await pool.query("SELECT * FROM pages WHERE id = $1 AND user_id = $2", [req.params.id, req.userId]);
  if (!rows[0]) return res.status(404).json({ error: "Page not found" });
  const status = await recheckPage(rows[0]);
  res.json({ id: rows[0].id, status });
});

// AUTO re-check (hourly for testing)
cron.schedule("0 * * * *", async () => {
  const { rows } = await pool.query("SELECT * FROM pages");
  for (const page of rows) {
    await recheckPage(page);
  }
  console.log("Rechecked", rows.length, "pages");
});

app.listen(process.env.PORT || 3000, () => console.log("running"));