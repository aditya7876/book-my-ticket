import express from "express";
import cors from "cors";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import pg from "pg";

let _pool;
let _schemaReady;

function getPool() {
  if (_pool) return _pool;
  _pool = new pg.Pool({
    host: process.env.PGHOST || "127.0.0.1",
    port: Number(process.env.PGPORT || 5433),
    user: process.env.PGUSER || "postgres",
    password: process.env.PGPASSWORD || "postgres",
    database: process.env.PGDATABASE || "sql_class_2_db",
    max: Number(process.env.PGPOOL_MAX || 20),
    connectionTimeoutMillis: Number(process.env.PG_CONN_TIMEOUT_MS || 0),
    idleTimeoutMillis: Number(process.env.PG_IDLE_TIMEOUT_MS || 0),
    ssl:
      process.env.PGSSL === "true"
        ? { rejectUnauthorized: false }
        : undefined,
  });
  return _pool;
}

const JWT_SECRET = process.env.JWT_SECRET || "dev_secret_change_me";
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || "7d";

function signToken(user) {
  return jwt.sign(
    { sub: String(user.id), email: user.email, name: user.name },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );
}

function authRequired(req, res, next) {
  const header = req.headers.authorization || "";
  const [type, token] = header.split(" ");
  if (type !== "Bearer" || !token) {
    res.status(401).send({ error: "Unauthorized" });
    return;
  }
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = {
      id: Number(decoded.sub),
      email: decoded.email,
      name: decoded.name,
    };
    next();
  } catch {
    res.status(401).send({ error: "Unauthorized" });
  }
}

async function ensureSchema() {
  const pool = getPool();

  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      email VARCHAR(255) UNIQUE NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS seats (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255),
      isbooked INT DEFAULT 0
    );
  `);

  const seatCount = await pool.query(
    `SELECT COUNT(*)::int AS count FROM seats;`
  );
  if ((seatCount.rows?.[0]?.count ?? 0) === 0) {
    await pool.query(`
      INSERT INTO seats (isbooked)
      SELECT 0 FROM generate_series(1, 20);
    `);
  }

  await pool.query(`
    ALTER TABLE seats
      ADD COLUMN IF NOT EXISTS booked_by_user_id INT,
      ADD COLUMN IF NOT EXISTS booked_at TIMESTAMPTZ;
  `);

  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'seats_booked_by_user_fk'
      ) THEN
        ALTER TABLE seats
          ADD CONSTRAINT seats_booked_by_user_fk
          FOREIGN KEY (booked_by_user_id) REFERENCES users(id)
          ON DELETE SET NULL;
      END IF;
    END
    $$;
  `);
}

async function ensureSchemaOnce() {
  if (_schemaReady) return _schemaReady;
  _schemaReady = ensureSchema().catch((e) => {
    _schemaReady = undefined;
    throw e;
  });
  return _schemaReady;
}

export function createApp() {
  const app = express();
  app.use(cors());
  app.use(express.json());

  // Health
  app.get("/health", async (_req, res) => {
    try {
      await ensureSchemaOnce();
      res.send({ ok: true });
    } catch (e) {
      res.status(500).send({ ok: false, error: "DB not ready" });
    }
  });

  // Auth
  app.post("/auth/register", async (req, res) => {
    try {
      await ensureSchemaOnce();
      const pool = getPool();

      const { name, email, password } = req.body || {};
      if (!name || !email || !password) {
        res.status(400).send({ error: "name, email, password are required" });
        return;
      }
      const normalizedEmail = String(email).trim().toLowerCase();
      const passwordHash = await bcrypt.hash(String(password), 10);

      const result = await pool.query(
        `INSERT INTO users (name, email, password_hash)
         VALUES ($1, $2, $3)
         RETURNING id, name, email, created_at`,
        [String(name).trim(), normalizedEmail, passwordHash]
      );

      const user = result.rows[0];
      const token = signToken(user);
      res.status(201).send({ user, token });
    } catch (ex) {
      if (ex?.code === "23505") {
        res.status(409).send({ error: "Email already registered" });
        return;
      }
      console.log(ex);
      res.status(500).send({ error: "Server error" });
    }
  });

  app.post("/auth/login", async (req, res) => {
    try {
      await ensureSchemaOnce();
      const pool = getPool();

      const { email, password } = req.body || {};
      if (!email || !password) {
        res.status(400).send({ error: "email, password are required" });
        return;
      }
      const normalizedEmail = String(email).trim().toLowerCase();
      const result = await pool.query(
        `SELECT id, name, email, password_hash FROM users WHERE email = $1`,
        [normalizedEmail]
      );
      if (result.rowCount === 0) {
        res.status(401).send({ error: "Invalid credentials" });
        return;
      }
      const userRow = result.rows[0];
      const ok = await bcrypt.compare(String(password), userRow.password_hash);
      if (!ok) {
        res.status(401).send({ error: "Invalid credentials" });
        return;
      }
      const user = { id: userRow.id, name: userRow.name, email: userRow.email };
      const token = signToken(user);
      res.send({ user, token });
    } catch (ex) {
      console.log(ex);
      res.status(500).send({ error: "Server error" });
    }
  });

  app.get("/me", authRequired, async (req, res) => {
    res.send({ user: req.user });
  });

  // Seats
  app.get("/seats", async (_req, res) => {
    await ensureSchemaOnce();
    const pool = getPool();
    const result = await pool.query("select * from seats");
    res.send(result.rows);
  });

  app.put("/seats/:id/book", authRequired, async (req, res) => {
    try {
      await ensureSchemaOnce();
      const pool = getPool();

      const id = req.params.id;
      const name = req.user?.name || "User";

      const conn = await pool.connect();
      await conn.query("BEGIN");

      const sql =
        "SELECT * FROM seats where id = $1 and isbooked = 0 FOR UPDATE";
      const result = await conn.query(sql, [id]);

      if (result.rowCount === 0) {
        res.send({ error: "Seat already booked" });
        await conn.query("ROLLBACK");
        conn.release();
        return;
      }

      const sqlU =
        "update seats set isbooked = 1, name = $2, booked_by_user_id = $3, booked_at = NOW() where id = $1";
      const updateResult = await conn.query(sqlU, [id, name, req.user.id]);

      await conn.query("COMMIT");
      conn.release();
      res.send(updateResult);
    } catch (ex) {
      console.log(ex);
      res.status(500).send({ error: "Server error" });
    }
  });

  // Backward compatible booking route (protected)
  app.put("/:id/:name", authRequired, async (req, res) => {
    try {
      await ensureSchemaOnce();
      const pool = getPool();

      const id = req.params.id;
      const name = req.params.name;

      const conn = await pool.connect();
      await conn.query("BEGIN");

      const sql =
        "SELECT * FROM seats where id = $1 and isbooked = 0 FOR UPDATE";
      const result = await conn.query(sql, [id]);
      if (result.rowCount === 0) {
        res.send({ error: "Seat already booked" });
        await conn.query("ROLLBACK");
        conn.release();
        return;
      }

      const sqlU =
        "update seats set isbooked = 1, name = $2, booked_by_user_id = $3, booked_at = NOW() where id = $1";
      const updateResult = await conn.query(sqlU, [id, name, req.user.id]);

      await conn.query("COMMIT");
      conn.release();
      res.send(updateResult);
    } catch (ex) {
      console.log(ex);
      res.status(500).send({ error: "Server error" });
    }
  });

  return app;
}

