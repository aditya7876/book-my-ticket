import dotenv from "dotenv";
import { createApp } from "../src/app.mjs";

dotenv.config();

const app = createApp();

export default function handler(req, res) {
  return app(req, res);
}

