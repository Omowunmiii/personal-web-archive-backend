# Personal Web Archive

Links rot. Pages get edited, paywalled or deleted, and a bookmark only saves the address, not what the page said. This app lets a user save any URL and keep a private, searchable copy of the page's text as it was when they saved it. It re-checks saved pages on a schedule and flags the ones that have **changed** or **disappeared**.

**Live app:** YOUR_VERCEL_LINK
**API:** YOUR_RENDER_LINK
**Note:** the backend is on a free tier and sleeps when idle, so the first request can take about a minute.

## What it does

- Sign up / log in. Every archive is private to its owner.
- Save a URL: the server fetches the page, extracts the readable text and stores it.
- Search across your saved pages (full-text search).
- Each page has a status: `ok`, `changed`, `gone` or `unreachable`.
- Pages are re-checked automatically every hour, or manually with the Re-check button.

## Stack and why I chose it

| Part | Choice | Why |
|---|---|---|
| Backend | Node + Express | I already know JavaScript, so I could focus on learning backend concepts instead of a new language. |
| Database | PostgreSQL | The data is relational (a user has many pages), search is built in, and it enforces structure. I considered MongoDB, but nested documents fit this data less naturally and its search is more basic. |
| Search | Postgres full-text search | Built in and enough at this scale. Elasticsearch would be another service to run for no real gain here. |
| Frontend | React (Vite) | I'm comfortable with React and Vite is quick to set up. |
| Scheduler | node-cron | Simplest option. A job queue (BullMQ + Redis) is better at scale, but it would add moving parts I didn't need for this. |
| Hosting | Render (API + database), Vercel (frontend) | Both have free tiers and deploy straight from GitHub. |

## How it works

**Capture.** When a URL is saved, the server downloads the page and runs it through Mozilla's Readability library (the same one behind Firefox Reader View) to strip menus, ads and scripts. The clean text is stored, along with a SHA-256 hash of it.

**Change detection.** On each re-check the page is fetched again, the text is extracted the same way and hashed. A different hash means `changed`. I hash the extracted text rather than the raw HTML because ads, timestamps and formatting change constantly and would cause false alerts. Whitespace is normalised before hashing for the same reason.

**Disappearance.** A `404` or `410` response marks a page `gone`. Network errors and timeouts mark it `unreachable` instead, because a failed request doesn't prove the page was deleted.

**The original is never overwritten.** A re-check only updates the status. The saved text stays exactly as it was when the user saved it, because the point of an archive is to keep what the page said.

## Security decisions

- Passwords are hashed with bcrypt, never stored in plain text.
- Login returns a signed JWT (7-day expiry). The frontend sends it on every request.
- Every query that touches pages filters by the logged-in user's id, so one user can't read or re-check another user's pages, even by guessing an id.
- All SQL uses parameterised queries to prevent SQL injection.
- Secrets (database URL, JWT secret) live in environment variables and are never committed.

## Failure handling

- A failed fetch on save returns a clear error instead of crashing the server.
- Re-checks run one page at a time, so the server doesn't hit many websites at once.
- Expired or invalid tokens log the user out in the frontend.

## Known limitations (and what I'd do next)

- **Free-tier hosting:** the service sleeps when idle, so the hourly re-check only runs while it is awake. The free database also expires after 30 days. A paid instance or an external scheduler would fix the first.
- **Server-side request forgery (SSRF):** the server fetches whatever URL a user gives it, including internal addresses. I'd block private and local IP ranges before opening this to the public.
- **JavaScript-rendered pages:** pages that build their content in the browser may save as empty text. A headless browser (Puppeteer) would solve this but is heavier to run.
- **One snapshot per page:** I keep the original text and a status, not a full history of every version. Next step would be a `snapshots` table plus a diff view.
- **No rate limiting or duplicate detection yet.**
- **Token in localStorage:** simple, but exposed if the site had an XSS bug. httpOnly cookies are safer.
- **Scale:** re-checking every page in a single loop works for a small number of users. At scale I'd move to a job queue with workers and per-domain rate limits.

## Run it locally

**Backend**
```
cd web-archive-backend
npm install
```
Create a `.env` file:
```
DATABASE_URL=postgres://USER:PASSWORD@localhost:5432/webarchive
JWT_SECRET=any-long-random-string
```
Create the tables:
```sql
CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL
);

CREATE TABLE pages (
  id SERIAL PRIMARY KEY,
  url TEXT NOT NULL,
  title TEXT,
  content TEXT,
  content_hash TEXT,
  status TEXT DEFAULT 'ok',
  saved_at TIMESTAMP DEFAULT NOW(),
  user_id INTEGER REFERENCES users(id)
);
```
Then `node index.js` (runs on port 3000).

**Frontend**
```
cd archive-frontend
npm install
npm run dev
```
For a deployed backend, set `VITE_API_URL` to its address (no trailing slash).

## API

| Method | Route | Auth | Purpose |
|---|---|---|---|
| POST | `/signup` | no | Create an account |
| POST | `/login` | no | Get a token |
| POST | `/pages` | yes | Save a URL |
| GET | `/pages` | yes | List your saved pages |
| GET | `/search?q=` | yes | Search your saved pages |
| POST | `/recheck/:id` | yes | Re-check one page now |
