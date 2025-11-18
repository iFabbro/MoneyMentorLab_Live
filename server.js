import TelegramBot from "node-telegram-bot-api";
import express from "express";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Carica il tuo index.js principale (quello rifattorizzato)
import "./index.js";

// Avvia un server Express minimale (Render lo richiede)
const app = express();
const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => {
  res.send("MoneyMentorLab Bot is running ✔️");
});

app.listen(PORT, () => {
  console.log(`🌐 Server attivo su PORT ${PORT}`);
});
