# IEEE QR — admin and shared API

This repository contains the private admin dashboard and the shared profile API. The public frontend lives in [IEEE-QR](https://github.com/joesajiabhin-source/IEEE-QR). Both sites use **one** Postgres database through this API; admin edits appear on public profiles without rebuilding the public site.

## Required production services

- A Postgres database (Neon from the Vercel Marketplace is supported)
- A Vercel Blob store for uploaded profile photos

Set these environment variables in the admin Vercel project for Production:

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Shared Postgres connection URL, server-side only |
| `BLOB_READ_WRITE_TOKEN` | Vercel Blob token, server-side only |
| `PUBLIC_BASE_URL` | Public project HTTPS origin for QR destinations and public API CORS |
| `VITE_PUBLIC_BASE_URL` | Same public origin, used by admin dashboard links |
| `ADMIN_EMAIL` | Initial administrator email |
| `ADMIN_PASSWORD` | Initial administrator password, at least 12 characters |

The first API request creates the schema, inserts the Abhinav profile once, and creates the first admin when no admin exists. The admin password is salted and hashed with scrypt. After setup, remove the plain `ADMIN_PASSWORD` environment variable if desired; existing login remains valid in Postgres. Never put a database URL, Blob token, or admin password in the public project's `VITE_*` variables.

Set `VITE_API_BASE_URL` in the public Vercel project to this admin project's HTTPS origin. Deploy the admin project first, then the public project, and update `PUBLIC_BASE_URL` to the public production URL. Redeploy after changing Vite variables because they are build-time values.

The admin app is a Vite frontend served with an Express API from one Vercel project. Locally, `npm run dev` serves the API on port 3001 and the dashboard on port 5173; a Postgres URL is still required for API requests. The public repo runs locally on port 5174 and proxies `/api` to port 3001.

## API

- Public: `GET /api/profiles/:slug`, `GET /api/profiles/:slug/qr`
- Admin only: `/api/admin/*` profile CRUD, status, photo upload, PNG QR, bulk QR ZIP
- Authentication: `/api/auth/login`, `/api/auth/me`, `/api/auth/logout`

Inactive profiles return 404 publicly. Admin sessions use secure, HTTP-only, same-site cookies, and sign-in is rate limited.
