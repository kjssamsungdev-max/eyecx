# Recovery Task — Admin + Community System

**Status:** Not recoverable from Cloudflare deployment history (all versions
rolled off by 15+ deploys on 2026-04-19).

**What was lost:**
- Worker routes: /api/login, /api/register, /api/community, /api/blog, /api/admin/*
- Pages client-side routing: /admin, /community, /blog

**What survives in D1 (blueprint for rebuild):**
- community_users table (1 row: admin@eyecx.com, role=admin, tier=agency, verified)
- curated_sources (33 rows — NamePros, DNJournal, etc.)
- curated_content (32 rows — real RSS articles)
- email_verifications (2 tokens)
- Schema for articles, threads, comments, sessions, password_resets, votes

**Rebuild plan (for a fresh session):**
1. Search past conversation history for the admin/auth implementation Claude Code
   built in the "Free expired domain hunter app" chat — code snippets may be
   quotable.
2. Re-implement /api/login, /api/register, /api/admin/* in worker/src/index.ts
3. Add client-side routing for /admin, /community, /blog in index.html
4. Commit to repo THIS TIME — do not deploy without committing.
5. Test locally before pushing.
