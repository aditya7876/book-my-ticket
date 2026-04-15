import { dirname } from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import { createApp } from "./src/app.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

dotenv.config();

const port = process.env.PORT || 8080;
const app = createApp();

app.get("/", (req, res) => {
  res.sendFile(__dirname + "/index.html");
});

app.listen(port, () => console.log("Server starting on port: " + port));
