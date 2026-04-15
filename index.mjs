//  CREATE TABLE seats (
//      id SERIAL PRIMARY KEY,
//      name VARCHAR(255),
//      isbooked INT DEFAULT 0
//  );
// INSERT INTO seats (isbooked)
// SELECT 0 FROM generate_series(1, 20);

import express from "express";
import pg from "pg";
import { dirname } from "path";
import { fileURLToPath } from "url";
import cors from "cors";
import dotenv from "dotenv";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

const __dirname = dirname(fileURLToPath(import.meta.url));

dotenv.config();

const port = process.env.PORT || 8080;

// Equivalent to mongoose connection
// Pool is nothing but group of connections
// If you pick one connection out of the pool and release it
// the pooler will keep that connection open for sometime to other clients to reuse
const pool = new pg.Pool({
  // Prefer explicit IPv4 default on Windows to avoid ::1 connection issues
  host: process.env.PGHOST || "127.0.0.1",
  port: Number(process.env.PGPORT || 5433),
  user: process.env.PGUSER || "postgres",
  password: process.env.PGPASSWORD || "postgres",
  database: process.env.PGDATABASE || "sql_class_2_db",
  max: Number(process.env.PGPOOL_MAX || 20),
  connectionTimeoutMillis: Number(process.env.PG_CONN_TIMEOUT_MS || 0),
  idleTimeoutMillis: Number(process.env.PG_IDLE_TIMEOUT_MS || 0),
});

const app = new express();
app.use(cors());
app.use(express.json());

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
  // users table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      email VARCHAR(255) UNIQUE NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // seats table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS seats (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255),
      isbooked INT DEFAULT 0
    );
  `);

  
  const seatCount = await pool.query(`SELECT COUNT(*)::int AS count FROM seats;`);
  if ((seatCount.rows?.[0]?.count ?? 0) === 0) {
    await pool.query(`
      INSERT INTO seats (isbooked)
      SELECT 0 FROM generate_series(1, 20);
    `);
  }

  // Extend seats 
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

app.get("/", (req, res) => {
  res.sendFile(__dirname + "/index.html");
});

// Auth: register
app.post("/auth/register", async (req, res) => {
  try {
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

// Auth: login
app.post("/auth/login", async (req, res) => {
  try {
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

//get all seats
app.get("/seats", async (req, res) => {
  const result = await pool.query("select * from seats"); 
  res.send(result.rows);
});


app.put("/seats/:id/book", authRequired, async (req, res) => {
  try {
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


app.put("/:id/:name", authRequired, async (req, res) => {
  try {
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

try {
  await ensureSchema();
} catch (ex) {
  console.error(
    "Database connection failed. Ensure Postgres is running and env vars are correct."
  );
  console.error(
    `Tried: ${process.env.PGHOST || "127.0.0.1"}:${process.env.PGPORT || 5433} db=${process.env.PGDATABASE || "sql_class_2_db"}`
  );
  throw ex;
}

app.listen(port, () => console.log("Server starting on port: " + port));
