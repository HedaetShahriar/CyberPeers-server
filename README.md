# cyberpeers-server

TypeScript + Express API server for CyberPeers.

This service:

- Connects to MongoDB and stores user profiles in a `users` collection.
- Logs user/admin actions in an `activities` collection.
- Uses Firebase Admin to verify Firebase ID tokens (Bearer tokens) for authentication.
- Provides admin-only endpoints for user management and dashboard stats.

## Tech stack

- Node.js (TypeScript runtime via `ts-node` in development)
- Express (v5)
- MongoDB Node driver
- Firebase Admin SDK (auth token verification)
- `jsonwebtoken` (installed; see JWT section below)
- CORS + dotenv

## Project structure

- `index.ts` — Express app, middleware, MongoDB + Firebase Admin setup, routes
- `package.json` — dependencies and scripts
- `nodemon.json` — dev runner config (`ts-node index.ts`)
- `tsconfig.json` — TypeScript compiler settings (CommonJS)
- `vercel.json` — Vercel deployment config

## Prerequisites

- Node.js installed (recommended: current LTS)
- A MongoDB connection string
- A Firebase service account JSON (for Firebase Admin)

## Install

```bash
npm install
```

## Environment variables

Create a `.env` file (or configure your hosting provider env vars) with:

- `PORT` (optional) — Port to run the server on (defaults to `3000`).
- `MONGO_DB_URI` (required) — MongoDB connection string.
- `DB_NAME` (required) — MongoDB database name.
- `FIREBASE_SERVICE_KEY` (required) — Base64-encoded Firebase service account JSON.

### `FIREBASE_SERVICE_KEY` format

The server expects the full Firebase service account JSON encoded as base64.

Example (PowerShell):

```powershell
# From the folder containing your serviceAccountKey.json
$bytes = [System.IO.File]::ReadAllBytes("serviceAccountKey.json")
$b64 = [Convert]::ToBase64String($bytes)
"FIREBASE_SERVICE_KEY=$b64" | Out-File -FilePath .env -Append -Encoding utf8
```

Or set it directly in your environment / Vercel project settings.

## Run locally

### Development (nodemon + ts-node)

```bash
npm run dev
```

`nodemon` watches `index.ts` and restarts automatically.

### Health check

- `GET /` → returns: `Cyberpeers Server is running`

## Authentication & authorization

### Firebase ID token

Most endpoints require a Firebase ID token sent as:

- Header: `Authorization: Bearer <FIREBASE_ID_TOKEN>`

The middleware `verifyToken` verifies the token using Firebase Admin and sets `req.user`.

### JWT (`jsonwebtoken`)

This project includes the `jsonwebtoken` package, but the current server code does **not** issue or verify app-signed JWTs using `jsonwebtoken`.

Important context:
- A Firebase ID token is itself a **JWT**, and this server validates it via Firebase Admin (`admin.auth().verifyIdToken(...)`).
- If you want to switch to (or add) your own JWT auth (signed with a shared secret or private key), you would need to implement that logic (e.g., verify `Authorization: Bearer <token>` with `jwt.verify(...)`) and introduce the required config (commonly something like `JWT_SECRET`).

### Email authorization (`verifyEmail`)

Some user endpoints also require the request query param `email` to match the email inside the decoded Firebase token:

- Query: `?email=user@example.com`

If the token email does not match the query email, the server responds with `403`.

### Admin authorization (`verifyAdmin`)

Admin routes check the `users` collection for the requester (using `req.query.email`) and require:

- `role === "admin"`

If not admin, the server responds with `403`.

## API endpoints

Base URL depends on where you host the service (local: `http://localhost:3000`).

### Public

#### `GET /`

Returns a simple string indicating the server is running.

---

### Users

#### `POST /user` (protected)

Creates a new user or updates last login time if the user already exists.

- Auth: `verifyToken`
- Body: user object (must include at least `email`; typically also includes `name`)
- Behavior:
  - If user **does not exist**:
    - Sets defaults: `role = "user"`, `status = "active"`
    - Sets timestamps: `createdAt`, `last_loggedIn` (ISO strings)
    - Inserts user into `users`
    - Inserts an activity: `"<name> created an account"`
  - If user **already exists**:
    - Updates `last_loggedIn`
    - Inserts an activity: `"<name> Logged in"`

Response:

- `{ message, result }`

#### `GET /user?email=...` (protected)

Returns a user profile.

- Auth: `verifyToken` + `verifyEmail`
- Query: `email` (must match token email)
- Adds a computed field:
  - `daysActive`: number of days since `createdAt`

Errors:

- `404` if user not found

#### `PATCH /user/profile?email=...` (protected)

Updates a user profile with the fields provided in the body.

- Auth: `verifyToken` + `verifyEmail`
- Query: `email` (must match token email)
- Body: partial user fields to update
- Also logs an activity: `"<name> updated their profile"`

Response:

- `{ message, result }`

#### `GET /user/activities?email=...` (protected)

Returns activities for a user.

- Auth: `verifyToken` + `verifyEmail`
- Query: `email` (must match token email)
- Returns activities sorted by newest first
- Adds a computed field per activity:
  - `timestamp`: number of days since `createdAt`

---

### Admin

All admin routes require:

- Auth header `Authorization: Bearer ...`
- Query param `email` corresponding to the admin user

#### `GET /users?email=...` (admin only)

Returns all users.

- Auth: `verifyToken` + `verifyAdmin`

#### `GET /admin/stats?email=...` (admin only)

Returns dashboard statistics and recent activities.

- Auth: `verifyToken` + `verifyAdmin`
- Response includes:
  - `totalUsers`
  - `activeUsers`
  - `suspendedUsers`
  - `recentActivities` (count; note: currently computed from `activitiesCollection.countDocuments({ role: "admin" })`)
  - `activities` (last 5 activities, with computed `timestamp` in days)

#### `PATCH /user/role/:id?email=...` (admin only)

Updates a user’s role.

- Auth: `verifyToken` + `verifyAdmin`
- Route param: `id` (MongoDB ObjectId string)
- Query: `email` (admin email)
- Body: `{ "role": "admin" | "user" | ... }`
- Protections:
  - Admin cannot change their own role (`email: { $ne: adminEmail }`)
  - Cannot change role of suspended users (`status: { $ne: "suspended" }`)
- Logs an activity like:
  - `"<adminName> changed role of <userName> to <role>"`

Response:

- `{ message, result }`

#### `PATCH /user/status/:id?email=...` (admin only)

Updates a user’s status.

- Auth: `verifyToken` + `verifyAdmin`
- Route param: `id` (MongoDB ObjectId string)
- Query: `email` (admin email)
- Body: `{ "status": "active" | "suspended" | ... }`
- Protection:
  - Admin cannot change their own status (`email: { $ne: adminEmail }`)
- Logs an activity like:
  - `"<adminName> changed status of <userName> to <status>"`

Response:

- `{ message, result }`

## MongoDB data model (as used by this server)

### `users` collection

Created/updated by the API. Fields observed/created in code:

- `email` (string)
- `name` (string, expected from client)
- `role` (string) — default: `"user"`
- `status` (string) — default: `"active"`
- `createdAt` (ISO string)
- `last_loggedIn` (ISO string)
- additional profile fields may be added via `PATCH /user/profile`

### `activities` collection

Inserted by the API. Fields observed in code:

- `userEmail` or `adminEmail`
- `action` (string)
- `createdAt` (ISO string)

The API also adds a computed `timestamp` (days ago) when returning activities, but this is not necessarily stored in MongoDB.

## Deployment

### Vercel

This project includes [vercel.json](vercel.json) configured to route all requests to `index.ts` using `@vercel/node`.

To deploy:

- Push the repo to GitHub
- Import the project in Vercel
- Set environment variables in Vercel project settings:
  - `MONGO_DB_URI`, `DB_NAME`, `FIREBASE_SERVICE_KEY` (and optionally `PORT`)

## Troubleshooting

- **Server crashes on startup**: check required env vars exist (`MONGO_DB_URI`, `DB_NAME`, `FIREBASE_SERVICE_KEY`).
- **403 Forbidden on user routes**: ensure `?email=` matches the Firebase token email.
- **403 only admins allowed**: ensure the requester’s user document in MongoDB has `role: "admin"`.
- **MongoDB connection issues**: verify `MONGO_DB_URI` is correct and accessible from your environment.

## Scripts

- `npm run dev` — start development server with nodemon
