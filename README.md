# Book My Ticket (Hackathon)

Backend-only implementation extending the starter code with:

- **User registration**
- **User login (JWT)**
- **Protected seat booking**
- **Duplicate seat booking prevention**
- **Bookings associated to the logged-in user**

## Tech

- Node.js + Express
- PostgreSQL (`pg`)
- JWT auth (`jsonwebtoken`)
- Password hashing (`bcryptjs`)

## Setup

### 1) Install deps

```bash
npm install
```

### 2) Configure environment

Copy `.env.example` to `.env` and update values if needed.

```bash
copy .env.example .env
```

### 3) Start Postgres with Docker (recommended)

From the project root:

```bash
docker compose up -d
```

This starts Postgres on **localhost:5433** (container 5432 → host 5433) with:

- User: `postgres`
- Password: `postgres`
- Database: `sql_class_2_db`

Your `.env` should match:

```env
PGHOST=127.0.0.1
PGPORT=5433
PGUSER=postgres
PGPASSWORD=postgres
PGDATABASE=sql_class_2_db
```

### 4) Create seats table (first time only)

This project expects a Postgres DB (defaults match the original starter code):

- Host: `localhost`
- Port: `5433`
- User: `postgres`
- Password: `postgres`
- DB: `sql_class_2_db`

The server auto-creates the `users` table and extends `seats` with:

- `booked_by_user_id`
- `booked_at`

You still need the starter `seats` table + initial data. If you don’t have it yet:

```sql
CREATE TABLE seats (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255),
  isbooked INT DEFAULT 0
);

INSERT INTO seats (isbooked)
SELECT 0 FROM generate_series(1, 20);
```

## Run

```bash
npm run dev
```

Server runs on `http://localhost:8080` (or `PORT`).

## Deploy to Vercel

Vercel cannot run your local Docker Postgres. Use a hosted Postgres (Neon / Supabase / Railway, etc) and set env vars.

### 1) Create a hosted Postgres database

Get connection details (host, port, user, password, db). If your provider requires SSL, set `PGSSL=true`.

### 2) Add Environment Variables in Vercel

In Vercel Project → Settings → Environment Variables:

- `PGHOST`
- `PGPORT`
- `PGUSER`
- `PGPASSWORD`
- `PGDATABASE`
- `PGSSL` = `true` (only if your provider requires SSL)
- `JWT_SECRET`
- `JWT_EXPIRES_IN` (optional)

### 3) Deploy

- Push the repo to GitHub
- Import the repo in Vercel
- Deploy

After deploy, open:

- `/` for the UI
- `/health` to confirm API+DB is reachable

## API

### Auth

#### Register

`POST /auth/register`

Body:

```json
{ "name": "Aman", "email": "aman@example.com", "password": "secret123" }
```

Response: `{ user, token }`

#### Login

`POST /auth/login`

Body:

```json
{ "email": "aman@example.com", "password": "secret123" }
```

Response: `{ user, token }`

#### Current user

`GET /me` (protected)

Header:

- `Authorization: Bearer <token>`

### Seats

#### List seats

`GET /seats` (public)

#### Book a seat (protected)

`PUT /seats/:id/book`

Header:

- `Authorization: Bearer <token>`

Behavior:

- Only authenticated users can book
- Uses a transaction + `SELECT ... FOR UPDATE` to prevent race conditions
- Returns `{ error: "Seat already booked" }` if taken
- Stores `booked_by_user_id` and `booked_at`

### Backward compatibility endpoint

The original starter booking endpoint still exists, but is now **protected**:

- `PUT /:id/:name`

This keeps the route shape but enforces auth to satisfy the hackathon requirement that booking is protected.

