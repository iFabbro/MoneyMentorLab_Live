const TelegramBot = require("node-telegram-bot-api");
const fs = require("fs");
const path = require("path");
const axios = require("axios");

// === CONFIG ===
const BOT_TOKEN = "7966583498:AAF77XJ5jbgVjJLic2Q0H20ILXV8vW6-fms";
const ADMIN_ID = 167482252;
const BASE = "/data/data/com.termux/files/home/MoneyMentorLab_bot";
const DATA_FILE = path.join(BASE, "data.json");
const PREMIUM_FILE = path.join(BASE, "premium_users.json");
const USERS_FILE = path.join(BASE, "users.json");
const FEEDBACK_FILE = path.join(BASE, "feedback.json");
const BACKUP_DIR = path.join(BASE, "backups");

// === CACHE MEMORIA ===
const memoryCache = {
  premium: { users: [], lastUpdate: 0 },
  data: { content: null, lastUpdate: 0 },
  prices: {
    stocks: {},
    crypto: {},
    lastUpdated: null
  }
};

// === RATE LIMITING ===
const rateLimit = new Map();
const RATE_LIMIT_WINDOW = 1000; // 1 secondo
const RATE_LIMIT_MAX = 5; // max 5 richieste per secondo

// === LOGGING ===
const logger = {
  info: (msg) => console.log(`[INFO] ${new Date().toISOString()}: ${msg}`),
  error: (msg) => console.error(`[ERROR] ${new Date().toISOString()}: ${msg}`),
  warn: (msg) => console.warn(`[WARN] ${new Date().toISOString()}: ${msg}`)
};

// === FILE HELPERS ===
function ensureFile(filePath, defaultContent) {
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, typeof defaultContent === "string" ? defaultContent : JSON.stringify(defaultContent, null, 2));
    logger.info(`Creato file: ${filePath}`);
  }
}

function loadJSON(filePath) {
  try { 
    return JSON.parse(fs.readFileSync(filePath, "utf8")); 
  } catch (e) { 
    logger.error(`Errore caricamento ${filePath}: ${e.message}`);
    return {}; 
  }
}

function saveJSON(filePath, data) {
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  } catch (e) {
    logger.error(`Errore salvataggio ${filePath}: ${e.message}`);
  }
}

// === CACHE HELPERS ===
function getPremiumUsers() {
  const now = Date.now();
  if (now - memoryCache.premium.lastUpdate < 30000) { // 30 secondi cache
    return memoryCache.premium.users;
  }
  
  try {
    const users = JSON.parse(fs.readFileSync(PREMIUM_FILE));
    memoryCache.premium = { users, lastUpdate: now };
    return users;
  } catch (e) {
    logger.error("Errore caricamento premium users: " + e.message);
    return [];
  }
}

function getData() {
  const now = Date.now();
  if (memoryCache.data.content && now - memoryCache.data.lastUpdate < 5000) {
    return memoryCache.data.content;
  }
  
  const data = loadJSON(DATA_FILE);
  memoryCache.data = { content: data, lastUpdate: now };
  return data;
}

// === VALIDATION ===
function isValidUserInput(text) {
  return typeof text === 'string' && text.length > 0 && text.length < 2000;
}

function checkRateLimit(userId) {
  const now = Date.now();
  const userData = rateLimit.get(userId) || { count: 0, lastReset: now };
  
  if (now - userData.lastReset > RATE_LIMIT_WINDOW) {
    userData.count = 0;
    userData.lastReset = now;
  }
  
  userData.count++;
  rateLimit.set(userId, userData);
  
  return userData.count <= RATE_LIMIT_MAX;
}

// === PRICE API ===
async function getLiveStockPrice(symbol) {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}`;
    const response = await axios.get(url, { timeout: 10000 });
    const data = response.data;
    
    if (data.chart?.result?.[0]?.meta) {
      const meta = data.chart.result[0].meta;
      const regularMarketPrice = meta.regularMarketPrice;
      const previousClose = meta.previousClose;
      const change = regularMarketPrice - previousClose;
      const changePercent = (change / previousClose) * 100;
      
      return {
        name: meta.symbol,
        price: regularMarketPrice,
        change: change,
        change_percent: change >= 0 ? `+${changePercent.toFixed(2)}%` : `${changePercent.toFixed(2)}%`
      };
    }
    return null;
  } catch (error) {
    logger.error(`Error fetching stock price for ${symbol}: ${error.message}`);
    return null;
  }
}

async function getLiveCryptoPrice(symbol) {
  try {
    const url = `https://api.coingecko.com/api/v3/simple/price?ids=${symbol.toLowerCase()}&vs_currencies=usd&include_24hr_change=true`;
    const response = await axios.get(url, { timeout: 10000 });
    const data = response.data;
    
    if (data[symbol.toLowerCase()]) {
      const cryptoData = data[symbol.toLowerCase()];
      return {
        name: symbol,
        price: cryptoData.usd,
        change_24h: cryptoData.usd_24h_change
      };
    }
    return null;
  } catch (error) {
    logger.error(`Error fetching crypto price for ${symbol}: ${error.message}`);
    return null;
  }
}

async function getStockPrice(symbol) {
  const cache = memoryCache.prices.stocks[symbol];
  if (cache && Date.now() - cache.timestamp < 300000) {
    return cache.data;
  }
  
  const livePrice = await getLiveStockPrice(symbol);
  if (livePrice) {
    memoryCache.prices.stocks[symbol] = {
      data: livePrice,
      timestamp: Date.now()
    };
  }
  return livePrice;
}

async function getCryptoPrice(symbol) {
  const cache = memoryCache.prices.crypto[symbol];
  if (cache && Date.now() - cache.timestamp < 300000) {
    return cache.data;
  }
  
  const livePrice = await getLiveCryptoPrice(symbol);
  if (livePrice) {
    memoryCache.prices.crypto[symbol] = {
      data: livePrice,
      timestamp: Date.now()
    };
  }
  return livePrice;
}

// Simboli supportati
const STOCK_SYMBOLS = ["AAPL", "MSFT", "GOOGL", "AMZN", "TSLA", "META", "NVDA", "JPM", "JNJ", "V"];
const CRYPTO_SYMBOLS = ["bitcoin", "ethereum", "binancecoin", "ripple", "cardano", "solana", "polkadot", "dogecoin"];

// Ensure essentials
ensureFile(DATA_FILE, "{}");
ensureFile(PREMIUM_FILE, "[]");
ensureFile(USERS_FILE, "[]");
ensureFile(FEEDBACK_FILE, "[]");
if (!fs.existsSync(BACKUP_DIR)) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  logger.info(`Creata directory backup: ${BACKUP_DIR}`);
}

// Global uptime
const START_TIME = Date.now();
// === BOT CORE ===
function startBot() {
  const bot = new TelegramBot(BOT_TOKEN, { polling: true });
  logger.info("✅ MoneyMentorLab avviato correttamente...");

  // HOT-RELOAD data.json
  setInterval(() => { 
    try {
      memoryCache.data.content = null; // Invalida cache
    } catch (e) {
      logger.error("Hot-reload error: " + e.message);
    }
  }, 5000);

  // Helpers
  const isPremium = (id) => id === ADMIN_ID || getPremiumUsers().includes(id);

  // User tracking
  function registerUserFrom(msgOrFrom) {
    try {
      const from = msgOrFrom.from ? msgOrFrom.from : msgOrFrom;
      if (!from || !from.id) return;
      
      // Rate limiting per registrazione
      if (!checkRateLimit(`register_${from.id}`)) return;
      
      const users = loadJSON(USERS_FILE);
      const exists = users.find(u => u.id === from.id);
      if (!exists) {
        users.push({
          id: from.id,
          username: from.username || null,
          first_name: from.first_name || null,
          last_name: from.last_name || null,
          joined_at: new Date().toISOString()
        });
        saveJSON(USERS_FILE, users);
        logger.info(`Nuovo utente registrato: ${from.id} - ${from.first_name || 'N/A'}`);
      }
    } catch (e) {
      logger.error("User register error: " + e.message);
    }
  }

  // Backups (ogni 12 ore)
  function doBackup() {
    try {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      [USERS_FILE, PREMIUM_FILE, DATA_FILE].forEach(src => {
        if (fs.existsSync(src)) {
          const base = path.basename(src);
          const dest = path.join(BACKUP_DIR, `${base}.${stamp}.bak`);
          fs.copyFileSync(src, dest);
        }
      });
      logger.info("🧰 Backup eseguito: " + stamp);
    } catch (e) {
      logger.error("Backup error: " + e.message);
    }
  }
  
  setInterval(doBackup, 12 * 60 * 60 * 1000);
  setTimeout(doBackup, 5000);

  // === MENU HELPERS ===
  const DATA = getData();
  const WELCOME = DATA.welcome || "Benvenuto in MoneyMentorLab! 💰\n\nIl tuo assistente personale per la gestione finanziaria.";
  
  function mainMenu() {
    return {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [{ text: "📘 Guide", callback_data: "guide_menu" }],
          [{ text: "💼 Portafogli", callback_data: "portafogli_menu" }],
          [{ text: "📊 Consigli & Tool", callback_data: "tool" }],
          [{ text: "💰 Prezzi Mercato", callback_data: "market_prices" }],
          [{ text: "💎 Area Premium", callback_data: "premium" }],
          [{ text: "💬 Supporto Chat", url: "https://t.me/Cash_LabBot" }],
          [{ text: "⚠️ Disclaimer", callback_data: "disclaimer" }],
          [{ text: "👥 Community", callback_data: "community" }]
        ]
      }
    };
  }
  
  async function safeEdit(chatId, message_id, text, options) {
    try { 
      await bot.editMessageText(text, { chat_id: chatId, message_id, ...options }); 
    } catch (e) {
      const m = String(e.message || "");
      if (m.includes("message is not modified") || m.includes("message to edit not found")) return;
      logger.error("editMessageText error: " + m);
    }
  }

  // === MESSAGE HANDLERS ===
  
  // START
  bot.onText(/\/start/, (msg) => {
    if (!checkRateLimit(msg.from.id)) {
      return bot.sendMessage(msg.chat.id, "❌ Troppe richieste! Aspetta un attimo.").catch(() => {});
    }
    
    registerUserFrom(msg);
    const chatId = msg.chat.id;
    bot.sendMessage(chatId, WELCOME, mainMenu()).catch(e => {
      logger.error("Start message error: " + e.message);
    });
  });

  // STATS (Admin)
  bot.onText(/^\/stats$/, async (msg) => {
    if (msg.from.id !== ADMIN_ID) return;
    
    const users = loadJSON(USERS_FILE);
    const premium = getPremiumUsers();
    
    // ultimi 5 utenti
    const last5 = [...users].reverse().slice(0, 5);
    
    // ultimo backup
    let lastBackup = "N/D";
    try {
      const files = fs.readdirSync(BACKUP_DIR)
        .filter(n => n.endsWith(".bak"))
        .map(n => ({ n, t: fs.statSync(path.join(BACKUP_DIR, n)).mtimeMs }))
        .sort((a,b) => b.t - a.t);
      if (files.length) lastBackup = new Date(files[0].t).toISOString();
    } catch (e) {
      logger.error("Backup check error: " + e.message);
    }
    
    // uptime
    const uptimeMs = Date.now() - START_TIME;
    const d = Math.floor(uptimeMs / 86400000);
    const h = Math.floor((uptimeMs % 86400000) / 3600000);
    const m = Math.floor((uptimeMs % 3600000) / 60000);

    let txt = `📊 *MoneyMentorLab — Stats*\n\n` +
      `👥 Utenti totali: *${users.length}*\n` +
      `💎 Premium totali: *${premium.length}*\n` +
      `🧰 Ultimo backup: *${lastBackup}*\n` +
      `⏱️ Uptime: *${d}g ${h}h ${m}m*\n\n` +
      `🆕 *Ultimi 5 utenti:*\n`;
      
    if (last5.length === 0) {
      txt += `— Nessuno —`;
    } else {
      last5.forEach(u => {
        const name = [u.first_name, u.last_name].filter(Boolean).join(" ") || "—";
        const usern = u.username ? `@${u.username}` : "";
        txt += `• ${name} ${usern} — ${u.id}\n`;
      });
    }
    
    bot.sendMessage(ADMIN_ID, txt, { parse_mode: "Markdown" }).catch(() => {});
  });

  // === FEEDBACK SYSTEM ===
  const AWAIT_FEEDBACK = new Set();
  // === MENU HANDLERS ===
  
  // GUIDE MENU
  function handleGuideMenu(chatId, mid) {
    return safeEdit(chatId, mid,
      "📘 *Guide pratiche* — Scegli l'argomento che vuoi approfondire:",
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "💰 Gestione del denaro", callback_data: "guida1" }],
            [{ text: "🧱 Strumenti per investire", callback_data: "guida2" }],
            [{ text: "🏗️ Costruisci il tuo portafoglio", callback_data: "guida3" }],
            [{ text: "⚠️ Errori più comuni", callback_data: "guida4" }],
            [{ text: "⬅️ Torna indietro", callback_data: "back_main" }]
          ]
        }
      }
    );
  }

  // PORTAFOGLI MENU
  function handlePortafogliMenu(chatId, mid) {
    return safeEdit(chatId, mid,
      "💼 *Portafogli MoneyMentorLab* — Scegli il profilo d'investimento:",
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "📊 Portafoglio Cauto", callback_data: "p1" }],
            [{ text: "⚖️ Portafoglio Bilanciato", callback_data: "p2" }],
            [{ text: "🚀 Portafoglio Dinamico", callback_data: "p3" }],
            [{ text: "🌍 Portafoglio Globale ETF", callback_data: "p4" }],
            [{ text: "💸 Portafoglio Rendita", callback_data: "p5" }],
            [{ text: "⬅️ Torna indietro", callback_data: "back_main" }]
          ]
        }
      }
    );
  }

  // TOOL MENU
  function handleToolMenu(chatId, mid) {
    return safeEdit(chatId, mid,
      "📊 *Consigli & Tool* — Scegli l'area operativa:",
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "⚙️ Automazioni finanziarie", callback_data: "tool_auto" }],
            [{ text: "📱 App & monitoraggio dal telefono", callback_data: "tool_app" }],
            [{ text: "🧾 Pianificazione fiscale", callback_data: "tool_tax" }],
            [{ text: "🧘 Psicologia & disciplina", callback_data: "tool_psy" }],
            [{ text: "🔔 Rischi & paracadute", callback_data: "tool_risk" }],
            [{ text: "⬅️ Torna indietro", callback_data: "back_main" }]
          ]
        }
      }
    );
  }

  // MARKET PRICES
  async function handleMarketPrices(chatId, mid) {
    return safeEdit(chatId, mid,
      `💰 *Prezzi di Mercato in Tempo Reale*

*Dati live da Yahoo Finance & CoinGecko*
*Ultimo aggiornamento:* ${new Date().toLocaleTimeString('it-IT')}

Seleziona una categoria:`,
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "📊 Indici Azionari", callback_data: "indices_prices" }],
            [{ text: "📈 Azioni Top 10", callback_data: "stock_prices" }],
            [{ text: "₿ Criptovalute", callback_data: "crypto_prices" }],
            [{ text: "🔄 Aggiorna Tutti", callback_data: "refresh_all_prices" }],
            [{ text: "⬅️ Torna al menu", callback_data: "back_main" }]
          ]
        }
      }
    );
  }

  // INDICI AZIONARI
  async function handleIndicesPrices(chatId, mid) {
    await safeEdit(chatId, mid, "📊 *Recupero indici azionari in corso...*", {
      parse_mode: "Markdown"
    });

    const indicesSymbols = [
      "^GSPC", // S&P 500
      "^DJI",  // Dow Jones
      "^IXIC", // NASDAQ
      "^FTSE", // FTSE 100
      "^GDAXI", // DAX
      "^FCHI", // CAC 40
      "^N225", // Nikkei 225
      "^HSI",  // Hang Seng
      "^BSESN", // SENSEX
      "^MIB"   // FTSE MIB
    ];

    const indicesNames = {
      "^GSPC": "S&P 500",
      "^DJI": "Dow Jones",
      "^IXIC": "NASDAQ",
      "^FTSE": "FTSE 100",
      "^GDAXI": "DAX",
      "^FCHI": "CAC 40",
      "^N225": "Nikkei 225",
      "^HSI": "Hang Seng",
      "^BSESN": "SENSEX",
      "^MIB": "FTSE MIB"
    };

    let indicesText = `📊 *Indici Azionari Globali - Prezzi Live*\n\n`;
    let successCount = 0;
    
    // Processa in parallelo per performance
    const indicesPromises = indicesSymbols.map(symbol => getStockPrice(symbol));
    const indicesResults = await Promise.allSettled(indicesPromises);
    
    indicesResults.forEach((result, index) => {
      const symbol = indicesSymbols[index];
      const name = indicesNames[symbol] || symbol;
      if (result.status === 'fulfilled' && result.value) {
        const indexData = result.value;
        const changeIcon = indexData.change >= 0 ? '📈' : '📉';
        indicesText += `${changeIcon} *${name}*\n`;
        indicesText += `💵 $${indexData.price.toFixed(2)} | ${indexData.change_percent}\n\n`;
        successCount++;
      } else {
        indicesText += `❌ *${name}*\nDati non disponibili\n\n`;
      }
    });
    
    indicesText += `_${successCount}/10 indici caricati_\n`;
    indicesText += `_Aggiornato: ${new Date().toLocaleTimeString('it-IT')}_`;
    
    return safeEdit(chatId, mid, indicesText, {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [{ text: "🇺🇸 S&P 500", callback_data: "index_^GSPC" }, { text: "🇺🇸 Dow Jones", callback_data: "index_^DJI" }],
          [{ text: "🇺🇸 NASDAQ", callback_data: "index_^IXIC" }, { text: "🇬🇧 FTSE 100", callback_data: "index_^FTSE" }],
          [{ text: "🇩🇪 DAX", callback_data: "index_^GDAXI" }, { text: "🇫🇷 CAC 40", callback_data: "index_^FCHI" }],
          [{ text: "🔄 Aggiorna", callback_data: "indices_prices" }],
          [{ text: "⬅️ Menu Prezzi", callback_data: "market_prices" }]
        ]
      }
    });
  }

  // STOCK PRICES
  async function handleStockPrices(chatId, mid) {
    await safeEdit(chatId, mid, "📈 *Recupero prezzi azioni in corso...*", {
      parse_mode: "Markdown"
    });

    let stocksText = `📈 *Azioni Top 10 - Prezzi Live*\n\n`;
    let successCount = 0;
    
    // Processa in parallelo per performance
    const stockPromises = STOCK_SYMBOLS.map(symbol => getStockPrice(symbol));
    const stockResults = await Promise.allSettled(stockPromises);
    
    stockResults.forEach((result, index) => {
      const symbol = STOCK_SYMBOLS[index];
      if (result.status === 'fulfilled' && result.value) {
        const stock = result.value;
        const changeIcon = stock.change >= 0 ? '📈' : '📉';
        stocksText += `${changeIcon} *${symbol}*\n`;
        stocksText += `💵 $${stock.price.toFixed(2)} | ${stock.change_percent}\n\n`;
        successCount++;
      } else {
        stocksText += `❌ *${symbol}*\nDati non disponibili\n\n`;
      }
    });
    
    stocksText += `_${successCount}/10 azioni caricate_\n`;
    stocksText += `_Aggiornato: ${new Date().toLocaleTimeString('it-IT')}_`;
    
    return safeEdit(chatId, mid, stocksText, {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [{ text: "🍎 Dettaglio AAPL", callback_data: "stock_AAPL" }, { text: "💻 Dettaglio MSFT", callback_data: "stock_MSFT" }],
          [{ text: "🔍 Dettaglio GOOGL", callback_data: "stock_GOOGL" }, { text: "📦 Dettaglio AMZN", callback_data: "stock_AMZN" }],
          [{ text: "🚗 Dettaglio TSLA", callback_data: "stock_TSLA" }, { text: "👥 Dettaglio META", callback_data: "stock_META" }],
          [{ text: "🎮 Dettaglio NVDA", callback_data: "stock_NVDA" }],
          [{ text: "🔄 Aggiorna", callback_data: "stock_prices" }],
          [{ text: "⬅️ Menu Prezzi", callback_data: "market_prices" }]
        ]
      }
    });
  }

  // CRYPTO PRICES
  async function handleCryptoPrices(chatId, mid) {
    await safeEdit(chatId, mid, "₿ *Recupero prezzi crypto in corso...*", {
      parse_mode: "Markdown"
    });

    let cryptoText = `₿ *Criptovalute - Prezzi Live*\n\n`;
    let successCount = 0;
    
    // Processa in parallelo per performance
    const cryptoPromises = CRYPTO_SYMBOLS.map(symbol => getCryptoPrice(symbol));
    const cryptoResults = await Promise.allSettled(cryptoPromises);
    
    cryptoResults.forEach((result, index) => {
      const symbol = CRYPTO_SYMBOLS[index];
      if (result.status === 'fulfilled' && result.value) {
        const crypto = result.value;
        const changeIcon = crypto.change_24h >= 0 ? '📈' : '📉';
        const symbolName = symbol.toUpperCase();
        cryptoText += `${changeIcon} *${symbolName}*\n`;
        cryptoText += `💵 $${crypto.price.toLocaleString()} | ${crypto.change_24h >= 0 ? '+' : ''}${crypto.change_24h?.toFixed(2)}%\n\n`;
        successCount++;
      } else {
        cryptoText += `❌ *${symbol.toUpperCase()}*\nDati non disponibili\n\n`;
      }
    });
    
    cryptoText += `_${successCount}/8 crypto caricate_\n`;
    cryptoText += `_Aggiornato: ${new Date().toLocaleTimeString('it-IT')}_`;
    
    return safeEdit(chatId, mid, cryptoText, {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [{ text: "₿ Dettaglio BTC", callback_data: "crypto_bitcoin" }, { text: "Ξ Dettaglio ETH", callback_data: "crypto_ethereum" }],
          [{ text: "💠 Dettaglio BNB", callback_data: "crypto_binancecoin" }, { text: "✖️ Dettaglio XRP", callback_data: "crypto_ripple" }],
          [{ text: "🔶 Dettaglio ADA", callback_data: "crypto_cardano" }, { text: "◎ Dettaglio SOL", callback_data: "crypto_solana" }],
          [{ text: "🔄 Aggiorna", callback_data: "crypto_prices" }],
          [{ text: "⬅️ Menu Prezzi", callback_data: "market_prices" }]
        ]
      }
    });
  }

  // SINGLE INDEX DETAIL
  async function handleIndexDetail(chatId, mid, symbol) {
    await safeEdit(chatId, mid, `📊 *Recupero indice ${symbol}...*`, {
      parse_mode: "Markdown"
    });

    const indicesNames = {
      "^GSPC": "S&P 500",
      "^DJI": "Dow Jones",
      "^IXIC": "NASDAQ",
      "^FTSE": "FTSE 100",
      "^GDAXI": "DAX",
      "^FCHI": "CAC 40",
      "^N225": "Nikkei 225",
      "^HSI": "Hang Seng",
      "^BSESN": "SENSEX",
      "^MIB": "FTSE MIB"
    };

    const index = await getStockPrice(symbol);
    const name = indicesNames[symbol] || symbol;
    
    if (index) {
      const changeIcon = index.change >= 0 ? '📈' : '📉';
      const indexText = 
        `${changeIcon} *${name}*\n\n` +
        `💵 **Prezzo:** $${index.price.toFixed(2)}\n` +
        `🔄 **Variazione:** ${index.change >= 0 ? '+' : ''}${index.change.toFixed(2)} (${index.change_percent})\n` +
        `📊 **Simbolo:** ${symbol}\n\n` +
        `_Dati live da Yahoo Finance_\n` +
        `_Aggiornato: ${new Date().toLocaleTimeString('it-IT')}_`;
      
      return safeEdit(chatId, mid, indexText, {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "🔄 Aggiorna", callback_data: `index_${symbol}` }],
            [{ text: "📊 Tutti gli Indici", callback_data: "indices_prices" }],
            [{ text: "⬅️ Menu Prezzi", callback_data: "market_prices" }]
          ]
        }
      });
    } else {
      return safeEdit(chatId, mid, `❌ Impossibile recuperare il prezzo di ${name}`, {
        reply_markup: {
          inline_keyboard: [
            [{ text: "🔄 Riprova", callback_data: `index_${symbol}` }],
            [{ text: "⬅️ Menu Prezzi", callback_data: "market_prices" }]
          ]
        }
      });
    }
  }

  // SINGLE STOCK DETAIL
  async function handleStockDetail(chatId, mid, symbol) {
    await safeEdit(chatId, mid, `📈 *Recupero prezzo ${symbol}...*`, {
      parse_mode: "Markdown"
    });

    const stock = await getStockPrice(symbol);
    
    if (stock) {
      const changeIcon = stock.change >= 0 ? '📈' : '📉';
      const stockText = 
        `${changeIcon} *${symbol}*\n\n` +
        `💵 **Prezzo:** $${stock.price.toFixed(2)}\n` +
        `🔄 **Variazione:** ${stock.change >= 0 ? '+' : ''}${stock.change.toFixed(2)} (${stock.change_percent})\n` +
        `📊 **Nome:** ${stock.name || 'N/D'}\n\n` +
        `_Dati live da Yahoo Finance_\n` +
        `_Aggiornato: ${new Date().toLocaleTimeString('it-IT')}_`;
      
      return safeEdit(chatId, mid, stockText, {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "🔄 Aggiorna", callback_data: `stock_${symbol}` }],
            [{ text: "📈 Tutte le Azioni", callback_data: "stock_prices" }],
            [{ text: "⬅️ Menu Prezzi", callback_data: "market_prices" }]
          ]
        }
      });
    } else {
      return safeEdit(chatId, mid, `❌ Impossibile recuperare il prezzo di ${symbol}`, {
        reply_markup: {
          inline_keyboard: [
            [{ text: "🔄 Riprova", callback_data: `stock_${symbol}` }],
            [{ text: "⬅️ Menu Prezzi", callback_data: "market_prices" }]
          ]
        }
      });
    }
  }

  // SINGLE CRYPTO DETAIL
  async function handleCryptoDetail(chatId, mid, symbol) {
    await safeEdit(chatId, mid, `₿ *Recupero prezzo ${symbol}...*`, {
      parse_mode: "Markdown"
    });

    const crypto = await getCryptoPrice(symbol);
    
    if (crypto) {
      const changeIcon = crypto.change_24h >= 0 ? '📈' : '📉';
      const cryptoText = 
        `${changeIcon} *${symbol.toUpperCase()}*\n\n` +
        `💵 **Prezzo:** $${crypto.price.toLocaleString()}\n` +
        `🔄 **Variazione 24h:** ${crypto.change_24h >= 0 ? '+' : ''}${crypto.change_24h?.toFixed(2)}%\n` +
        `📊 **Nome:** ${crypto.name || 'N/D'}\n\n` +
        `_Dati live da CoinGecko_\n` +
        `_Aggiornato: ${new Date().toLocaleTimeString('it-IT')}_`;
      
      return safeEdit(chatId, mid, cryptoText, {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "🔄 Aggiorna", callback_data: `crypto_${symbol}` }],
            [{ text: "₿ Tutte le Crypto", callback_data: "crypto_prices" }],
            [{ text: "⬅️ Menu Prezzi", callback_data: "market_prices" }]
          ]
        }
      });
    } else {
      return safeEdit(chatId, mid, `❌ Impossibile recuperare il prezzo di ${symbol.toUpperCase()}`, {
        reply_markup: {
          inline_keyboard: [
            [{ text: "🔄 Riprova", callback_data: `crypto_${symbol}` }],
            [{ text: "⬅️ Menu Prezzi", callback_data: "market_prices" }]
          ]
        }
      });
    }
  }
  // === CALLBACK HANDLER ===
  bot.on("callback_query", async (query) => {
    // Rate limiting
    if (!checkRateLimit(query.from.id)) {
      return bot.answerCallbackQuery(query.id, { 
        text: "❌ Troppe richieste! Aspetta un attimo.", 
        show_alert: false 
      }).catch(() => {});
    }

    registerUserFrom(query);
    const chatId = query.message.chat.id;
    const mid = query.message.message_id;
    const data = query.data;
    
    bot.answerCallbackQuery(query.id).catch(() => {});

    try {
      // Gestione callback principali
      switch(data) {
        case "back_main":
          return safeEdit(chatId, mid, WELCOME, mainMenu());
        
        case "guide_menu":
          return handleGuideMenu(chatId, mid);
        
        case "portafogli_menu":
          return handlePortafogliMenu(chatId, mid);
        
        case "tool":
          return handleToolMenu(chatId, mid);
        
        case "market_prices":
          return handleMarketPrices(chatId, mid);
        
        case "indices_prices":
          return handleIndicesPrices(chatId, mid);
        
        case "stock_prices":
          return handleStockPrices(chatId, mid);
        
        case "crypto_prices":
          return handleCryptoPrices(chatId, mid);
        
        case "refresh_all_prices":
          memoryCache.prices.stocks = {};
          memoryCache.prices.crypto = {};
          return safeEdit(chatId, mid, "✅ Cache prezzi svuotata! I prossimi aggiornamenti mostreranno dati fresh.", {
            reply_markup: {
              inline_keyboard: [
                [{ text: "📊 Vedi Indici", callback_data: "indices_prices" }],
                [{ text: "📈 Vedi Azioni", callback_data: "stock_prices" }],
                [{ text: "₿ Vedi Crypto", callback_data: "crypto_prices" }],
                [{ text: "⬅️ Menu Prezzi", callback_data: "market_prices" }]
              ]
            }
          });
        
        case "feedback_start":
          AWAIT_FEEDBACK.add(chatId);
          return safeEdit(chatId, mid,
`🗣️ *Feedback attivo*

Scrivi ora un messaggio con il tuo *suggerimento* o la *segnalazione*.  
Quando invii, lo riceveremo subito e lo useremo per migliorare il bot.

*Limite: 2000 caratteri*

Per uscire senza inviare, torna al menu.`,
            {
              parse_mode: "Markdown",
              reply_markup: { inline_keyboard: [[{ text: "⬅️ Torna al menu", callback_data: "back_main" }]] }
            }
          );
        
        case "disclaimer":
          return safeEdit(chatId, mid,
`⚠️ *Disclaimer Money Mentor Lab*

Money Mentor Lab fornisce informazioni, strumenti e materiali di carattere *educativo, divulgativo e formativo*.  
Non costituisce in alcun modo *consulenza finanziaria personalizzata*, né raccomandazioni operative, fiscali o di investimento.

Tutti i contenuti presenti nel bot, nei portafogli modello e nei file Premium hanno finalità esclusivamente informative.  
Ogni utente è pienamente responsabile delle proprie decisioni di investimento, gestione del denaro o pianificazione patrimoniale.

Le performance passate non garantiscono risultati futuri.  
Money Mentor Lab non si assume alcuna responsabilità per eventuali perdite economiche derivanti dall'utilizzo diretto o indiretto delle informazioni fornite.

Per scelte finanziarie personalizzate, consulta sempre un *consulente finanziario indipendente o abilitato*.

📌 Continuando a utilizzare il bot, dichiari di aver letto e accettato questo disclaimer.`,
            { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{ text: "⬅️ Torna al menu principale", callback_data: "back_main" }]] } }
          );
        
        case "community":
          const currentData = getData();
          return safeEdit(chatId, mid,
`👥 *Community Money Mentor Lab*

Questo è il canale ufficiale per aggiornamenti, release del bot e anteprime esclusive.  
🎯 Il gruppo dedicato verrà aperto quando il canale raggiunge *200 iscritti*.

Entra e resta aggiornato:`,
            {
              parse_mode: "Markdown",
              disable_web_page_preview: true,
              reply_markup: { inline_keyboard: [[{ text: "📣 Apri il Canale", url: currentData.community_link || "#" }], [{ text: "⬅️ Torna al menu", callback_data: "back_main" }]] }
            }
          );
        
        default:
          // Gestione dinamica per indici, stock e crypto
          if (data.startsWith('index_')) {
            const symbol = data.replace('index_', '');
            return handleIndexDetail(chatId, mid, symbol);
          }
          
          if (data.startsWith('stock_')) {
            const symbol = data.replace('stock_', '');
            return handleStockDetail(chatId, mid, symbol);
          }
          
          if (data.startsWith('crypto_')) {
            const symbol = data.replace('crypto_', '');
            return handleCryptoDetail(chatId, mid, symbol);
          }
          
          // Gestione contenuti dinamici
          const dynamicData = getData();
          const g = (dynamicData.guides || []).find(x => x.id === data);
          if (g) {
            return safeEdit(chatId, mid, `${g.title}\n\n${g.text}`, {
              parse_mode: "Markdown",
              disable_web_page_preview: true,
              reply_markup: { inline_keyboard: [[{ text: "👉 Apri la guida completa", url: g.link }], [{ text: "⬅️ Torna alle Guide", callback_data: "guide_menu" }]] }
            });
          }
          
          const p = (dynamicData.portafogli || []).find(x => x.id === data);
          if (p) {
            return safeEdit(chatId, mid, `${p.title}\n\n${p.text}`, {
              parse_mode: "Markdown",
              disable_web_page_preview: true,
              reply_markup: { inline_keyboard: [[{ text: "👉 Apri il portafoglio completo", url: p.link }], [{ text: "⬅️ Torna ai Portafogli", callback_data: "portafogli_menu" }]] }
            });
          }
          
          const t = (dynamicData.tools || []).find(x => x.id === data);
          if (t) {
            return safeEdit(chatId, mid, `${t.title}\n\n${t.text}`, {
              parse_mode: "Markdown",
              disable_web_page_preview: true,
              reply_markup: { inline_keyboard: [[{ text: "👉 Apri la guida completa", url: t.link }], [{ text: "⬅️ Torna a Consigli & Tool", callback_data: "tool" }]] }
            });
          }
          
          // PREMIUM AREA
          if (data === "premium") {
            const premiumData = getData();
            const stripe = premiumData.stripe || {};
            const premium = isPremium(chatId);
            const premiumStatus = premium
              ? "✅ *Accesso Premium attivo!* Puoi scaricare subito i materiali."
              : "🔒 *Accesso bloccato.* Acquista uno dei pacchetti qui sotto per sbloccare i file Premium.";

            const text =
`${premiumStatus}

💎 *Area Premium MoneyMentorLab*

Strumenti e materiali professionali per gestire, costruire e ottimizzare i tuoi investimenti.

📦 **Strumenti Pro – 79 €**  
💡 *Gestione e automazione finanziaria avanzata*  
• FIRE Calculator  
• Pianificatore Finanziario  
• Simulatore PAC/PIC  
• Tracker Dividendi, Compounding, TFR e Pensione  

💼 **Portafogli Modello – 69 €**  
📊 *Strategie operative già testate e replicabili*  
• 10 Portafogli dei grandi investitori  
• ETF per ogni profilo: Cauto, Bilanciato, Dinamico, Globale, Rendita  
• Portafogli Immobiliari e Crypto  

📊 **Liste & Database – 49 €**  
📂 *Analisi e scelta dei migliori strumenti*  
• Database ETF MML (ISIN, TER, rendimento, categoria)  
• Liste Azioni Dividendo e Obbligazioni filtrate  

💎 **Pacchetto Completo – 129 €**  
🔥 *Tutti i materiali Premium in un unico download*  
• Include Strumenti Pro + Portafogli + Database  
• Aggiornamenti inclusi e accesso permanente.

📜 *Nota importante:*  
I materiali Premium di Money Mentor Lab hanno scopo *educativo e informativo*.  
Non costituiscono consulenza finanziaria personalizzata.  
Consulta sempre il *Disclaimer* nel menu principale per maggiori dettagli.`;

            const keyboard = [
              [
                premium ? { text: "📂 Strumenti", callback_data: "zip_strumenti" } : { text: "💳 Strumenti – 79€", url: stripe.strumenti },
                premium ? { text: "📂 Portafogli", callback_data: "zip_portafogli" } : { text: "💳 Portafogli – 69€", url: stripe.portafogli }
              ],
              [
                premium ? { text: "📂 Database", callback_data: "zip_liste" } : { text: "💳 Liste – 49€", url: stripe.liste },
                premium ? { text: "💎 Completo", callback_data: "zip_completo" } : { text: "💎 Completo – 129€", url: stripe.completo }
              ],
              [{ text: "⬅️ Torna al menu principale", callback_data: "back_main" }]
            ];

            return safeEdit(chatId, mid, text, { parse_mode: "Markdown", reply_markup: { inline_keyboard: keyboard } });
          }
          
          // PREMIUM DOWNLOADS
          if (["zip_strumenti", "zip_portafogli", "zip_liste", "zip_completo"].includes(data)) {
            if (!isPremium(chatId)) {
              const downloadData = getData();
              const stripe = downloadData.stripe || {};
              const map = {
                zip_strumenti: stripe.strumenti,
                zip_portafogli: stripe.portafogli,
                zip_liste: stripe.liste,
                zip_completo: stripe.completo
              };
              return bot.sendMessage(chatId, `⚠️ Accesso riservato agli utenti Premium.\nPer acquistare:\n👉 ${map[data] || "#"}`, { parse_mode: "Markdown" });
            }
            
            const filenameMap = {
              zip_strumenti: "Strumenti Pro MML.zip",
              zip_portafogli: "Portafogli Modello MML.zip",
              zip_liste: "Liste Database MML.zip",
              zip_completo: "Premium MML 💎.zip"
            };
            
            const filePath = path.join(BASE, filenameMap[data]);
            if (!fs.existsSync(filePath)) {
              return bot.sendMessage(chatId, "❌ File non trovato sul server. Contatta l'assistenza.");
            }
            
            await bot.sendMessage(chatId, "📦 Invio del file in corso...");
            return bot.sendDocument(chatId, fs.createReadStream(filePath), { 
              caption: `✅ ${filenameMap[data]} - Invio completato!` 
            }).catch(e => {
              logger.error("File send error: " + e.message);
              bot.sendMessage(chatId, "❌ Errore nell'invio del file. Riprova più tardi.");
            });
          }
      }
    } catch (err) {
      logger.error("Callback error: " + err.message);
      bot.answerCallbackQuery(query.id, { text: "Errore temporaneo. Riprova.", show_alert: false }).catch(() => {});
    }
  });

  // === FEEDBACK HANDLER ===
  bot.on("message", (msg) => {
    if (!msg || !msg.text || msg.text.startsWith("/")) return;

    const chatId = msg.chat.id;
    if (!AWAIT_FEEDBACK.has(chatId)) return;

    // Rate limiting
    if (!checkRateLimit(msg.from.id)) {
      return bot.sendMessage(chatId, "❌ Troppe richieste! Aspetta un attimo.");
    }

    const text = msg.text.trim();
    if (!isValidUserInput(text)) {
      bot.sendMessage(chatId, "❌ Messaggio troppo lungo o vuoto. Limite: 2000 caratteri.", {
        reply_markup: { inline_keyboard: [[{ text: "⬅️ Torna al menu", callback_data: "back_main" }]] }
      });
      AWAIT_FEEDBACK.delete(chatId);
      return;
    }

    // Salva feedback
    try {
      const arr = loadJSON(FEEDBACK_FILE);
      arr.push({
        user_id: msg.from.id,
        username: msg.from.username || null,
        first_name: msg.from.first_name || null,
        last_name: msg.from.last_name || null,
        message: text,
        sent_at: new Date().toISOString()
      });
      saveJSON(FEEDBACK_FILE, arr);
    } catch (e) {
      logger.error("Feedback save error: " + e.message);
    }

    // Inoltra all'admin
    const uname = msg.from.username ? `@${msg.from.username}` : "";
    const fullName = [msg.from.first_name, msg.from.last_name].filter(Boolean).join(" ");
    const header = `🗣️ *Nuovo feedback*`;
    const body = `Da: *${fullName || "Utente"}* ${uname}\nID: \`${msg.from.id}\`\n\n${text}`;
    bot.sendMessage(ADMIN_ID, `${header}\n\n${body}`, { parse_mode: "Markdown" }).catch(() => {});

    // Conferma all'utente
    bot.sendMessage(chatId, "✅ Grazie! Il tuo feedback è stato inviato. Continuiamo a migliorare 🚀", {
      reply_markup: { inline_keyboard: [[{ text: "⬅️ Torna al menu", callback_data: "back_main" }]] }
    }).catch(() => {});

    AWAIT_FEEDBACK.delete(chatId);
  });

  // === ERROR HANDLING ===
  bot.on("polling_error", (err) => {
    logger.error("⚠️ Errore polling: " + (err?.code || err?.message || err));
    setTimeout(() => { 
      logger.info("♻️ Riavvio automatico del bot..."); 
      startBot(); 
    }, 5000);
  });
  
  process.on('uncaughtException', (error) => {
    logger.error('Uncaught Exception: ' + error.message);
  });
  
  process.on('unhandledRejection', (reason, promise) => {
    logger.error('Unhandled Rejection at: ' + promise + ' reason: ' + reason);
  });
}

// === AVVIO BOT ===
logger.info("🚀 Avvio MoneyMentorLab...");
startBot();
