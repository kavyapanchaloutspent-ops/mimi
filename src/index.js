import "dotenv/config";
import { readFileSync, writeFileSync } from "node:fs";
import pg from "pg";
const { Pool } = pg;
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  Partials,
} from "discord.js";

const token = String(process.env.DISCORD_TOKEN || "").trim();
if (!token) throw new Error("Thiáº¿u DISCORD_TOKEN");

const PREFIX = process.env.PREFIX || ".";
const BOT_NAME = process.env.BOT_NAME || "LoveBot";
const DATABASE_URL = String(process.env.DATABASE_URL || "").trim();
const dbPool = DATABASE_URL ? new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL.includes("render.com") ? { rejectUnauthorized: false } : undefined,
  max: 5,
}) : null;
let persistenceQueue = Promise.resolve();
const proposals = new Map();
const COUPLES_FILE = new URL("../couples.json", import.meta.url);
let couples = {};
try {
  couples = JSON.parse(readFileSync(COUPLES_FILE, "utf8"));
} catch {
  couples = {};
}

const INTIMACY_FILE = new URL("../intimacy.json", import.meta.url);
const DAILY_INTIMACY_LIMIT = 20;
let intimacy = {};
try {
  intimacy = JSON.parse(readFileSync(INTIMACY_FILE, "utf8"));
} catch {
  intimacy = {};
}

function coupleKey(firstId, secondId) {
  return [firstId, secondId].sort().join(":");
}

function saveIntimacy() {
  persistState();
}

function intimacyDay() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh" }).format(new Date());
}

function intimacyLevel(points) {
  if (points >= 600) return { level: 6, name: "Äá»‹nh má»‡nh trá»n Ä‘á»i", next: null };
  if (points >= 300) return { level: 5, name: "KhÃ´ng thá»ƒ tÃ¡ch rá»i", next: 600 };
  if (points >= 150) return { level: 4, name: "YÃªu sÃ¢u Ä‘áº­m", next: 300 };
  if (points >= 75) return { level: 3, name: "Quáº¥n nhau khÃ´ng rá»i", next: 150 };
  if (points >= 30) return { level: 2, name: "Äang say náº¯ng", next: 75 };
  return { level: 1, name: "Má»›i yÃªu", next: 30 };
}

function intimacyRecord(firstId, secondId) {
  const key = coupleKey(firstId, secondId);
  if (!intimacy[key]) intimacy[key] = { total: 0, day: intimacyDay(), daily: 0 };
  if (intimacy[key].day !== intimacyDay()) {
    intimacy[key].day = intimacyDay();
    intimacy[key].daily = 0;
  }
  return { key, record: intimacy[key] };
}

function addIntimacy(firstId, secondId, requestedPoints) {
  const { record } = intimacyRecord(firstId, secondId);
  const gained = Math.max(0, Math.min(requestedPoints, DAILY_INTIMACY_LIMIT - record.daily));
  record.daily += gained;
  record.total += gained;
  saveIntimacy();
  return { gained, ...record, ...intimacyLevel(record.total) };
}
const LOVE_DATA_FILE = new URL("../love-data.json", import.meta.url);
let loveData = { users: {}, relationships: {}, archives: {} };
try {
  const loaded = JSON.parse(readFileSync(LOVE_DATA_FILE, "utf8"));
  loveData = { users: loaded.users || {}, relationships: loaded.relationships || {}, archives: loaded.archives || {} };
} catch {}

function stateSnapshot() {
  return JSON.stringify({ couples, intimacy, loveData });
}

function persistState() {
  if (!dbPool) {
    writeFileSync(COUPLES_FILE, `${JSON.stringify(couples, null, 2)}\n`, "utf8");
    writeFileSync(INTIMACY_FILE, `${JSON.stringify(intimacy, null, 2)}\n`, "utf8");
    writeFileSync(LOVE_DATA_FILE, `${JSON.stringify(loveData, null, 2)}\n`, "utf8");
    return;
  }
  const snapshot = stateSnapshot();
  persistenceQueue = persistenceQueue
    .then(() => dbPool.query(
      `INSERT INTO love_bot_state (singleton_id, data, updated_at)
       VALUES (1, $1::jsonb, NOW())
       ON CONFLICT (singleton_id)
       DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
      [snapshot],
    ))
    .catch((error) => console.error("[postgres] save failed:", error.message));
}

async function initializePersistence() {
  if (!dbPool) {
    console.warn("[storage] DATABASE_URL chÆ°a cÃ³, Ä‘ang dÃ¹ng JSON cá»¥c bá»™.");
    return;
  }
  await dbPool.query(`
    CREATE TABLE IF NOT EXISTS love_bot_state (
      singleton_id SMALLINT PRIMARY KEY CHECK (singleton_id = 1),
      data JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  const result = await dbPool.query("SELECT data FROM love_bot_state WHERE singleton_id = 1");
  if (result.rows[0]?.data) {
    const stored = result.rows[0].data;
    couples = stored.couples || {};
    intimacy = stored.intimacy || {};
    loveData = {
      users: stored.loveData?.users || {},
      relationships: stored.loveData?.relationships || {},
      archives: stored.loveData?.archives || {},
    };
    console.log("[postgres] ÄÃ£ táº£i dá»¯ liá»‡u tÃ¬nh yÃªu tá»« PostgreSQL.");
  } else {
    persistState();
    await persistenceQueue;
    console.log("[postgres] ÄÃ£ nháº­p dá»¯ liá»‡u JSON hiá»‡n táº¡i vÃ o PostgreSQL.");
  }
}
function saveLoveData() {
  persistState();
}

function userData(userId) {
  if (!loveData.users[userId]) loveData.users[userId] = { coins: 0, lastDaily: null };
  return loveData.users[userId];
}

function relationshipData(firstId, secondId, create = true) {
  const key = coupleKey(firstId, secondId);
  if (!loveData.relationships[key] && create) {
    loveData.relationships[key] = {
      startedAt: new Date().toISOString(),
      status: "Äang yÃªu",
      nicknames: {},
      stats: { hon: 0, om: 0, namtay: 0, henho: 0, tangqua: 0, ngoaitinh: 0 },
      diary: [{ at: new Date().toISOString(), text: "Hai ngÆ°á»i báº¯t Ä‘áº§u má»‘i quan há»‡." }],
      gifts: {},
      lastCheat: null,
      pledgeUntil: null,
    };
  }
  const rel = loveData.relationships[key] || null;
  if (rel) {
    rel.startedAt ||= new Date().toISOString();
    rel.status ||= "Äang yÃªu";
    rel.nicknames ||= {};
    rel.stats = { hon: 0, om: 0, namtay: 0, henho: 0, tangqua: 0, ngoaitinh: 0, ...(rel.stats || {}) };
    rel.diary ||= [];
    rel.gifts ||= {};
  }
  return rel;
}

function addDiary(firstId, secondId, text) {
  const rel = relationshipData(firstId, secondId);
  rel.diary.push({ at: new Date().toISOString(), text });
  rel.diary = rel.diary.slice(-30);
  saveLoveData();
}

function updateRelationshipStat(firstId, secondId, stat, amount = 1) {
  const rel = relationshipData(firstId, secondId);
  rel.stats[stat] = (rel.stats[stat] || 0) + amount;
  saveLoveData();
}

function formatDate(value) {
  return new Intl.DateTimeFormat("vi-VN", { timeZone: "Asia/Ho_Chi_Minh", dateStyle: "medium" }).format(new Date(value));
}

function daysTogether(value) {
  return Math.max(1, Math.floor((Date.now() - new Date(value).getTime()) / 86_400_000) + 1);
}
function saveCouples() {
  persistState();
}

function partnerIdOf(userId) {
  return couples[userId] || null;
}

function setCouple(firstId, secondId) {
  couples[firstId] = secondId;
  couples[secondId] = firstId;
  relationshipData(firstId, secondId);
  saveCouples();
  saveLoveData();
}

function removeCouple(userId) {
  const partnerId = partnerIdOf(userId);
  if (!partnerId) return null;
  const key = coupleKey(userId, partnerId);
  const oldRel = loveData.relationships[key];
  if (oldRel) {
    oldRel.diary.push({ at: new Date().toISOString(), text: "Hai ngÆ°á»i Ä‘Ã£ chia tay." });
    const archive = { partnerIds: [userId, partnerId], ...oldRel, endedAt: new Date().toISOString() };
    for (const id of [userId, partnerId]) {
      if (!loveData.archives[id]) loveData.archives[id] = [];
      loveData.archives[id].push(archive);
      loveData.archives[id] = loveData.archives[id].slice(-5);
    }
  }
  delete couples[userId];
  delete couples[partnerId];
  delete intimacy[key];
  delete loveData.relationships[key];
  saveCouples();
  saveIntimacy();
  saveLoveData();
  return partnerId;
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ],
  partials: [Partials.Channel, Partials.Message],
});

const ACTIONS = {
  hon: { category: "kiss", color: 0xff4f9a, verb: "Ä‘Ã£ hÃ´n", ending: "má»™t ná»¥ hÃ´n tháº¥m thÃ­a Ä‘áº¿n muá»‘n tan cháº£y" },
  kiss: { category: "kiss", color: 0xff4f9a, verb: "Ä‘Ã£ hÃ´n", ending: "má»™t ná»¥ hÃ´n ngá»t Ä‘áº¿n sÃ¢u rÄƒng" },
  om: { category: "hug", color: 0xff8bbd, verb: "Ä‘Ã£ Ã´m", ending: "cháº·t Ä‘áº¿n má»©c má»i buá»“n phiá»n bay sáº¡ch" },
  hug: { category: "hug", color: 0xff8bbd, verb: "Ä‘Ã£ Ã´m", ending: "áº¥m hÆ¡n cáº£ chÄƒn mÃ¹a Ä‘Ã´ng" },
  auyem: { category: "cuddle", color: 0xf59bd0, verb: "Ä‘Ã£ Ã¢u yáº¿m", ending: "dá»‹u dÃ ng nhÆ° cáº£nh cuá»‘i phim tÃ¬nh cáº£m" },
  cuddle: { category: "cuddle", color: 0xf59bd0, verb: "Ä‘Ã£ Ã´m áº¥p", ending: "vÃ  nháº¥t quyáº¿t khÃ´ng chá»‹u buÃ´ng" },
  xoa: { category: "pat", color: 0xffb4d7, verb: "Ä‘Ã£ xoa Ä‘áº§u", ending: "ngoan nÃ o, hÃ´m nay váº¥t váº£ rá»“i" },
  pat: { category: "pat", color: 0xffb4d7, verb: "Ä‘Ã£ xoa Ä‘áº§u", ending: "nháº¹ nhÃ ng háº¿t má»©c cÃ³ thá»ƒ" },
  namtay: { category: "handhold", color: 0xff6fae, verb: "Ä‘Ã£ náº¯m tay", ending: "rá»“i kÃ©o nhau Ä‘i qua cáº£ tháº¿ giá»›i" },
  highfive: { category: "highfive", color: 0xffcc70, verb: "Ä‘Ã£ Ä‘áº­p tay", ending: "má»™t phÃ¡t cá»±c Äƒn Ã½" },
  choc: { category: "poke", color: 0xff8a9e, verb: "Ä‘Ã£ chá»c", ending: "cho Ä‘áº¿n khi ngÆ°á»i kia Ä‘á» máº·t" },
  poke: { category: "poke", color: 0xff8a9e, verb: "Ä‘Ã£ chá»c", ending: "vÃ¬ Ä‘Ã¡ng yÃªu quÃ¡ chá»‹u khÃ´ng ná»•i" },
  can: { category: "bite", color: 0xe76f8a, verb: "Ä‘Ã£ cáº¯n", ending: "má»™t cÃ¡i Ä‘á»ƒ Ä‘Ã¡nh dáº¥u chá»§ quyá»n" },
  bite: { category: "bite", color: 0xe76f8a, verb: "Ä‘Ã£ cáº¯n yÃªu", ending: "nhÆ°ng cháº¯c cháº¯n khÃ´ng Ä‘au Ä‘Ã¢u" },
  tho: { category: "blush", color: 0xff9eb5, verb: "Ä‘Ã£ lÃ m", ending: "Ä‘á» máº·t Ä‘áº¿n má»©c khÃ´ng dÃ¡m nhÃ¬n tháº³ng" },
  nhay: { category: "dance", color: 0xc77dff, verb: "Ä‘Ã£ kÃ©o", ending: "vÃ o má»™t Ä‘iá»‡u nháº£y chá»‰ dÃ nh cho hai ngÆ°á»i" },
  honmuah: { category: "blowkiss", fallback: "kiss", color: 0xff5d8f, verb: "Ä‘Ã£ gá»­i ná»¥ hÃ´n giÃ³ tá»›i", ending: "bay tháº³ng vÃ o tim" },
  qhtd: { category: "cuddle", fallback: "kiss", color: 0xb5179e, verb: "Ä‘Ã£ kÃ©o", ending: "vÃ o khÃ´ng gian riÃªng tÆ° rá»“i nháº¹ nhÃ ng Ä‘Ã³ng cá»­a láº¡i" },
};

const QUOTES = [
  "YÃªu khÃ´ng cáº§n hoÃ n háº£o, chá»‰ cáº§n hai ngÆ°á»i khÃ´ng bá» cuá»™c.",
  "Giá»¯a hÃ ng triá»‡u ngÆ°á»i, gáº·p Ä‘Ãºng nhau Ä‘Ã£ lÃ  má»™t phÃ©p mÃ u.",
  "BÃ¬nh yÃªn Ä‘Ã´i khi chá»‰ lÃ  cÃ³ má»™t ngÆ°á»i chá»‹u nghe mÃ¬nh ká»ƒ chuyá»‡n má»—i ngÃ y.",
  "TÃ¬nh yÃªu Ä‘áº¹p nháº¥t lÃ  khi cáº£ hai váº«n chá»n nhau sau nhá»¯ng ngÃ y khÃ´ng Ä‘áº¹p.",
  "KhÃ´ng cáº§n Ä‘i Ä‘Ã¢u xa, nÆ¡i cÃ³ ngÆ°á»i thÆ°Æ¡ng chÃ­nh lÃ  nhÃ .",
  "CÃ³ nhá»¯ng cÃ¡i náº¯m tay ngáº¯n thÃ´i nhÆ°ng Ä‘á»§ lÃ m áº¥m cáº£ má»™t ngÃ y dÃ i.",
  "ThÃ­ch má»™t ngÆ°á»i lÃ  tá»± nhiÃªn tháº¥y má»i bÃ i tÃ¬nh ca Ä‘á»u cÃ³ tÃªn há».",
  "Náº¿u trÃ¡i tim cÃ³ thÃ´ng bÃ¡o, cháº¯c tÃªn ngÆ°á»i áº¥y Ä‘ang hiá»‡n liÃªn tá»¥c.",
];

const ACTION_VARIANTS = {
  hon: [
    "má»™t ná»¥ hÃ´n tháº­t lÃ¢u nhÆ° muá»‘n giá»¯ cáº£ tháº¿ giá»›i láº¡i",
    "má»™t ná»¥ hÃ´n ngá»t Ä‘áº¿n má»©c tim muá»‘n nháº£y khá»i lá»“ng ngá»±c",
    "má»™t ná»¥ hÃ´n báº¥t ngá» lÃ m ngÆ°á»i kia Ä‘á» bá»«ng cáº£ máº·t",
    "má»™t ná»¥ hÃ´n dá»‹u dÃ ng nhÆ° cáº£nh cuá»‘i phim tÃ¬nh cáº£m",
    "má»™t ná»¥ hÃ´n tháº¯m thiáº¿t khiáº¿n thá»i gian nhÆ° Ä‘á»©ng yÃªn",
  ],
  kiss: [
    "má»™t ná»¥ hÃ´n ngá»t ngÃ o khÃ´ng muá»‘n rá»i",
    "má»™t ná»¥ hÃ´n vá»¥ng trá»™m nhÆ°ng Ä‘áº§y thÆ°Æ¡ng nhá»›",
    "má»™t ná»¥ hÃ´n nháº¹ lÃªn mÃ´i thay cho ngÃ n lá»i muá»‘n nÃ³i",
  ],
  om: [
    "tháº­t cháº·t Ä‘á»ƒ má»i buá»“n phiá»n bay sáº¡ch",
    "vÃ o lÃ²ng nhÆ° thá»ƒ Ä‘Ã£ nhá»› nhau cáº£ má»™t Ä‘á»i",
    "áº¥m Ã¡p Ä‘áº¿n má»©c cháº³ng ai muá»‘n buÃ´ng tay",
    "tá»« phÃ­a sau vÃ  thá»§ thá»‰ ráº±ng má»i chuyá»‡n rá»“i sáº½ á»•n",
    "má»™t cÃ¡i tháº­t lÃ¢u Ä‘á»ƒ sáº¡c Ä‘áº§y nÄƒng lÆ°á»£ng yÃªu thÆ°Æ¡ng",
  ],
  hug: [
    "áº¥m hÆ¡n cáº£ chiáº¿c chÄƒn giá»¯a mÃ¹a Ä‘Ã´ng",
    "cháº·t Ä‘áº¿n má»©c nghe Ä‘Æ°á»£c nhá»‹p tim cá»§a nhau",
    "dá»‹u dÃ ng nhÆ° Ä‘ang Ã´m Ä‘iá»u quÃ½ giÃ¡ nháº¥t",
  ],
  auyem: ["dá»‹u dÃ ng Ä‘áº¿n tan cháº£y", "tháº­t lÃ¢u dÆ°á»›i Ã¡nh nhÃ¬n Ä‘áº§y yÃªu thÆ°Æ¡ng", "nháº¹ nhÃ ng nhÆ° sá»£ lÃ m ngÆ°á»i kia tá»•n thÆ°Æ¡ng"],
  cuddle: ["vÃ  nháº¥t quyáº¿t khÃ´ng chá»‹u buÃ´ng", "trong vÃ²ng tay áº¥m Ã¡p nháº¥t", "Ä‘áº¿n khi cáº£ hai cÃ¹ng ngá»§ quÃªn"],
  xoa: ["rá»“i báº£o hÃ´m nay váº¥t váº£ rá»“i", "nháº¹ nhÃ ng nhÆ° dá»— dÃ nh má»™t chÃº mÃ¨o", "kÃ¨m má»™t Ã¡nh máº¯t Ä‘áº§y cÆ°ng chiá»u"],
  pat: ["nháº¹ nhÃ ng háº¿t má»©c cÃ³ thá»ƒ", "Ä‘á»ƒ thÆ°á»Ÿng cho sá»± Ä‘Ã¡ng yÃªu", "vÃ  khen ngoan tháº­t kháº½"],
  namtay: ["rá»“i kÃ©o nhau Ä‘i qua cáº£ tháº¿ giá»›i", "tháº­t cháº·t nhÆ° má»™t lá»i há»©a", "vÃ  khÃ´ng Ä‘á»‹nh buÃ´ng ra ná»¯a"],
  honmuah: ["bay tháº³ng vÃ o tim", "kÃ¨m theo cáº£ má»™t trá»i thÆ°Æ¡ng nhá»›", "lÃ m ngÆ°á»i nháº­n Ä‘á» máº·t ngay láº­p tá»©c"],
  qhtd: ["vÃ o phÃ²ng riÃªng rá»“i Ä‘Ã³ng cá»­a â€” pháº§n sau xin phÃ©p Ä‘á»ƒ trÃ­ tÆ°á»Ÿng tÆ°á»£ng lÃªn tiáº¿ng", "Ä‘i tÃ¢m sá»± riÃªng trong báº§u khÃ´ng khÃ­ cá»±c ká»³ Ä‘Ã¡ng ngá»", "biáº¿n máº¥t sau cÃ¡nh cá»­a cÃ¹ng táº¥m biá»ƒn miá»…n lÃ m phiá»n", "Ä‘i háº¹n hÃ² phiÃªn báº£n giá»›i háº¡n ngÆ°á»i xem"],
};

const PROPOSAL_LINES = [
  "Cáº­u cÃ³ Ä‘á»“ng Ã½ cÃ¹ng tá»› viáº¿t tiáº¿p cÃ¢u chuyá»‡n nÃ y, tá»« hÃ´m nay cho Ä‘áº¿n tháº­t lÃ¢u vá» sau khÃ´ng?",
  "Tháº¿ giá»›i rá»™ng nhÆ° váº­y, cáº­u cÃ³ muá»‘n tá»« nay cÃ¹ng tá»› chung má»™t lá»‘i vá» khÃ´ng?",
  "Tá»› khÃ´ng há»©a má»i ngÃ y Ä‘á»u hoÃ n háº£o, nhÆ°ng tá»› há»©a ngÃ y nÃ o cÅ©ng sáº½ chá»n cáº­u. Äá»“ng Ã½ nhÃ©?",
  "Cho tá»› má»™t Ä‘áº·c quyá»n: Ä‘Æ°á»£c á»Ÿ cáº¡nh, chÄƒm sÃ³c vÃ  thÆ°Æ¡ng cáº­u tháº­t lÃ¢u, Ä‘Æ°á»£c khÃ´ng?",
  "Tá»« láº§n Ä‘áº§u gáº·p cáº­u, tá»› Ä‘Ã£ muá»‘n tÆ°Æ¡ng lai cá»§a mÃ¬nh cÃ³ tÃªn cáº­u. Cáº­u Ä‘á»“ng Ã½ chá»©?",
  "Tá»› Ä‘Ã£ tÃ¬m tháº¥y ngÆ°á»i muá»‘n náº¯m tay Ä‘i háº¿t cháº·ng Ä‘Æ°á»ng rá»“i. NgÆ°á»i Ä‘Ã³ lÃ  cáº­u â€” mÃ¬nh yÃªu nhau nhÃ©?",
  "Náº¿u tÃ¬nh yÃªu lÃ  má»™t chuyáº¿n phiÃªu lÆ°u, cáº­u cÃ³ muá»‘n lÃ m báº¡n Ä‘á»“ng hÃ nh trá»n Ä‘á»i cá»§a tá»› khÃ´ng?",
  "Tim tá»› Ä‘Ã£ chá»n cáº­u máº¥t rá»“i. Cáº­u cÃ³ chá»‹u nháº­n láº¥y nÃ³ vÃ  á»Ÿ bÃªn tá»› khÃ´ng?",
];

function randomOf(items) {
  return items[Math.floor(Math.random() * items.length)];
}
function baseEmbed(title, description, color = 0xff6fae) {
  return new EmbedBuilder()
    .setColor(color)
    .setAuthor({ name: BOT_NAME })
    .setTitle(title)
    .setDescription(description)
    .setTimestamp();
}

function errorEmbed(text) {
  return baseEmbed("KhÃ´ng lÃ m Ä‘Æ°á»£c rá»“i", text, 0xe74c3c);
}

async function randomAnime(category, fallback = category) {
  try {
    const response = await fetch(`https://nekos.best/api/v2/${encodeURIComponent(category)}`, {
      headers: {
        "User-Agent": "HuyLoveCompanion (https://github.com/huyg00046/discord-love-bot)",
      },
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) throw new Error(`nekos.best HTTP ${response.status}`);
    const data = await response.json();
    const item = data?.results?.[0];
    if (item?.url) return { url: item.url, source: item.source_url || null, artist: item.artist_name || null };
  } catch (error) {
    console.warn("[nekos.best]", error.message);
  }
  try {
    const response = await fetch(`https://api.waifu.pics/sfw/${encodeURIComponent(fallback)}`, {
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) throw new Error(`waifu.pics HTTP ${response.status}`);
    const data = await response.json();
    if (data?.url) return { url: data.url, source: null, artist: null };
  } catch (error) {
    console.warn("[waifu.pics]", error.message);
  }
  return null;
}

function getTarget(message, args, { allowSelf = false } = {}) {
  const target = message.mentions.users.first();
  if (!target && !allowSelf) return { error: "HÃ£y mention má»™t ngÆ°á»i, vÃ­ dá»¥ `.hon @ngÆ°á»i_áº¥y`." };
  if (target?.id === message.author.id && !allowSelf) return { error: "Tá»± lÃ m vá»›i chÃ­nh mÃ¬nh nghe cÃ´ Ä‘Æ¡n quÃ¡, mention ngÆ°á»i khÃ¡c Ä‘i." };
  return { target: target || message.author, args };
}

async function sendAction(message, command) {
  const action = ACTIONS[command];
  const partnerId = partnerIdOf(message.author.id);
  if (!partnerId) {
    return message.reply({ embeds: [errorEmbed(`Báº¡n chÆ°a cÃ³ ngÆ°á»i yÃªu. HÃ£y dÃ¹ng \`${PREFIX}cauhon @user\` vÃ  chá» ngÆ°á»i áº¥y Ä‘á»“ng Ã½ trÆ°á»›c.`)] });
  }
  let target;
  try {
    target = await client.users.fetch(partnerId);
  } catch {
    return message.reply({ embeds: [errorEmbed("KhÃ´ng tÃ¬m tháº¥y tÃ i khoáº£n ngÆ°á»i yÃªu Ä‘Ã£ lÆ°u. HÃ£y thá»­ láº¡i sau.")] });
  }
const media = await randomAnime(action.category, action.fallback || action.category);
  const requestedPoints = command === "qhtd" ? 5 : ["hon", "kiss", "om", "hug", "auyem", "cuddle", "namtay", "honmuah"].includes(command) ? 3 : 2;
const progress = addIntimacy(message.author.id, partnerId, requestedPoints);
  const stat = ["hon", "kiss", "honmuah"].includes(command) ? "hon" : ["om", "hug", "auyem", "cuddle"].includes(command) ? "om" : command === "namtay" ? "namtay" : command;
  const rel = relationshipData(message.author.id, partnerId);
  rel.stats[stat] = (rel.stats[stat] || 0) + 1;
  if ((rel.lastLevel || 1) < progress.level) {
    rel.lastLevel = progress.level;
    rel.diary.push({ at: new Date().toISOString(), text: `TÃ¬nh yÃªu Ä‘áº¡t cáº¥p ${progress.level}: ${progress.name}.` });
  }
  saveLoveData();
  const lines = [
    `${message.author} **${action.verb}** ${target} â€” ${randomOf(ACTION_VARIANTS[command] || [action.ending])}.`,
    `-# ${QUOTES[Math.floor(Math.random() * QUOTES.length)]}`,
  ];
  const embed = baseEmbed("Má»™t chÃºt yÃªu thÆ°Æ¡ng", lines.join("\n\n"), action.color)
    .setFooter({ text: `YÃªu cáº§u bá»Ÿi ${message.author.username}` });
embed.addFields(
    { name: "ThÃ¢n máº­t", value: progress.gained ? `+${progress.gained} Ä‘iá»ƒm Â· tá»•ng **${progress.total}**` : `ÄÃ£ Ä‘áº¡t giá»›i háº¡n **${DAILY_INTIMACY_LIMIT} Ä‘iá»ƒm/ngÃ y**`, inline: true },
    { name: `Cáº¥p ${progress.level}`, value: progress.name, inline: true },
    { name: "HÃ´m nay", value: `${progress.daily}/${DAILY_INTIMACY_LIMIT} Ä‘iá»ƒm`, inline: true },
  );
  if (media?.url) embed.setImage(media.url);
  if (media?.artist) embed.addFields({ name: "GIF artist", value: media.artist, inline: true });
  return message.reply({ embeds: [embed], allowedMentions: { users: [message.author.id, target.id], parse: [] } });
}

function pairScore(a, b) {
  const pair = [a.id, b.id].sort().join(":");
  let hash = 2166136261;
  for (const char of pair) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return Math.abs(hash) % 101;
}

function scoreBar(score) {
  const filled = Math.round(score / 10);
  return `${"ðŸ’—".repeat(filled)}${"ðŸ–¤".repeat(10 - filled)} **${score}%**`;
}

async function sendShip(message) {
  const users = [...message.mentions.users.values()];
  const first = users[0] || message.author;
  const second = users[1] || (users[0] && users[0].id !== message.author.id ? message.author : null);
  if (!second || first.id === second.id) {
    return message.reply({ embeds: [errorEmbed("DÃ¹ng `.ship @A @B` hoáº·c `.ship @ngÆ°á»i_áº¥y`.")] });
  }
  const score = pairScore(first, second);
  const media = await randomAnime(score >= 50 ? "handhold" : "stare", "handhold");
  const verdict = score >= 90 ? "Äá»‹nh má»‡nh khÃ³a cá»©ng hai ngÆ°á»i rá»“i." : score >= 70 ? "CÃ³ mÃ¹i thÃ nh Ä‘Ã´i ráº¥t rÃµ." : score >= 40 ? "CÃ³ tia lá»­a, cáº§n chá»§ Ä‘á»™ng thÃªm." : "DuyÃªn Ä‘ang lag, thá»­ láº¡i kiáº¿p sau.";
  const embed = baseEmbed("MÃ¡y Ä‘o tÃ¬nh yÃªu", `${first} Ã— ${second}\n\n${scoreBar(score)}\n\n**${verdict}**`, 0xff477e);
  if (media?.url) embed.setImage(media.url);
  return message.reply({ embeds: [embed], allowedMentions: { users: [first.id, second.id], parse: [] } });
}

async function findSoulmate(message) {
  const subject = message.mentions.users.first() || message.author;
  await message.guild.members.fetch().catch(() => null);
  const candidates = [...message.guild.members.cache.values()]
    .map((member) => member.user)
    .filter((user) => !user.bot && user.id !== subject.id)
    .map((user) => ({ user, score: pairScore(subject, user) }))
    .sort((a, b) => b.score - a.score || a.user.id.localeCompare(b.user.id));

  if (!candidates.length) return message.reply({ embeds: [errorEmbed("Server chÆ°a cÃ³ ngÆ°á»i phÃ¹ há»£p Ä‘á»ƒ tÃ¬m duyÃªn.")] });
  const best = candidates.slice(0, 10);
  const perfect = candidates.filter((item) => item.score === 100);
  const ranking = best.map((item, index) => `**${index + 1}.** ${item.user} â€” **${item.score}%**`).join("\n");
  const verdict = perfect.length
    ? `\n\nTÃ¬m tháº¥y **${perfect.length} ngÆ°á»i Ä‘áº¡t 100%**: ${perfect.slice(0, 5).map((item) => `${item.user}`).join(", ")}`
    : `\n\nChÆ°a cÃ³ ai Ä‘áº¡t 100%. NgÆ°á»i há»£p nháº¥t hiá»‡n táº¡i lÃ  ${best[0].user} vá»›i **${best[0].score}%**.`;
  const embed = baseEmbed("MÃ¡y tÃ¬m duyÃªn", `Káº¿t quáº£ dÃ nh cho ${subject}:\n\n${ranking}${verdict}`, perfect.length ? 0xff2e63 : 0xff6fae)
    .setThumbnail(subject.displayAvatarURL({ size: 256 }))
    .setFooter({ text: `ÄÃ£ quÃ©t ${candidates.length} thÃ nh viÃªn tháº­t Â· Ä‘iá»ƒm cá»‘ Ä‘á»‹nh theo cáº·p Discord ID` });
  return message.reply({ embeds: [embed], allowedMentions: { parse: [] } });
}
async function sendLove(message) {
  const partnerId = partnerIdOf(message.author.id);
  if (!partnerId) {
    return message.reply({ embeds: [errorEmbed(`Báº¡n chÆ°a cÃ³ ngÆ°á»i yÃªu. HÃ£y dÃ¹ng \`${PREFIX}cauhon @user\` trÆ°á»›c.`)] });
  }
  const mentioned = message.mentions.users.first();
  if (mentioned && mentioned.id !== partnerId) {
    return message.reply({ embeds: [errorEmbed(`Báº¡n chá»‰ cÃ³ thá»ƒ dÃ¹ng lá»‡nh nÃ y vá»›i ngÆ°á»i yÃªu: <@${partnerId}>.`)], allowedMentions: { users: [partnerId], parse: [] } });
  }
  const target = mentioned || await client.users.fetch(partnerId);
  const score = pairScore(message.author, target);
  const embed = baseEmbed("Chá»‰ sá»‘ rung Ä‘á»™ng hÃ´m nay", `${message.author} dÃ nh cho ${target}\n\n${scoreBar(score)}\n\n${QUOTES[score % QUOTES.length]}`, 0xff5c8a);
  const media = await randomAnime(score > 60 ? "blush" : "smile", "blush");
  if (media?.url) embed.setImage(media.url);
  return message.reply({ embeds: [embed], allowedMentions: { users: [message.author.id, target.id], parse: [] } });
}

async function sendProposal(message) {
  const { target, error } = getTarget(message, []);
  if (error) return message.reply({ embeds: [errorEmbed(error)] });
  if (target.bot) return message.reply({ embeds: [errorEmbed("Cáº§u hÃ´n bot thÃ¬ bot chá»‰ biáº¿t chÃºc phÃºc thÃ´i.")] });

  const myPartner = partnerIdOf(message.author.id);
  const theirPartner = partnerIdOf(target.id);
  let kind = "new";
  let nextStatus = "Äang tÃ¬m hiá»ƒu";
  let requiredPoints = 0;
  if (myPartner || theirPartner) {
    if (myPartner !== target.id || theirPartner !== message.author.id) {
      return message.reply({ embeds: [errorEmbed("Má»™t trong hai ngÆ°á»i Ä‘Ã£ cÃ³ má»‘i quan há»‡ khÃ¡c nÃªn khÃ´ng thá»ƒ gá»­i lá»i nÃ y.")] });
    }
    kind = "upgrade";
    const rel = relationshipData(message.author.id, target.id);
    const total = intimacyRecord(message.author.id, target.id).record.total;
    if (rel.status === "Äang tÃ¬m hiá»ƒu") { nextStatus = "Äang yÃªu"; requiredPoints = 30; }
    else if (rel.status === "Äang yÃªu") { nextStatus = "ÄÃ­nh hÃ´n"; requiredPoints = 150; }
    else if (rel.status === "ÄÃ­nh hÃ´n") { nextStatus = "Káº¿t hÃ´n"; requiredPoints = 300; }
    else return message.reply({ embeds: [errorEmbed("Hai ngÆ°á»i Ä‘Ã£ káº¿t hÃ´n rá»“i, khÃ´ng thá»ƒ nÃ¢ng cáº¥p thÃªm ná»¯a.")] });
    if (total < requiredPoints) {
      return message.reply({ embeds: [errorEmbed(`Cáº§n Ã­t nháº¥t **${requiredPoints} Ä‘iá»ƒm thÃ¢n máº­t** Ä‘á»ƒ chuyá»ƒn tá»« **${rel.status}** sang **${nextStatus}**. Hiá»‡n cÃ³ ${total} Ä‘iá»ƒm.`)] });
    }
  }

  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  proposals.set(id, { proposerId: message.author.id, targetId: target.id, kind, nextStatus, requiredPoints, expiresAt: Date.now() + 5 * 60_000 });
  setTimeout(() => proposals.delete(id), 5 * 60_000);
  const media = await randomAnime("handhold", "kiss");
  const proposalLine = randomOf(PROPOSAL_LINES);
  const embed = baseEmbed(
    kind === "new" ? "Lá»i báº¯t Ä‘áº§u tÃ¬nh yÃªu" : `Lá»i háº¹n bÆ°á»›c sang: ${nextStatus}`,
    `${target}, ${message.author} Ä‘ang láº¥y háº¿t can Ä‘áº£m Ä‘á»ƒ há»i:\n\n**â€œ${proposalLine}â€**\n\nNáº¿u Ä‘á»“ng Ã½, tráº¡ng thÃ¡i sáº½ lÃ  **${nextStatus}**.`,
    0xff2e63,
  ).setFooter({ text: "Chá»‰ ngÆ°á»i nháº­n Ä‘Æ°á»£c tráº£ lá»i Â· háº¿t háº¡n sau 5 phÃºt" });
  if (media?.url) embed.setImage(media.url);
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`proposal:yes:${id}`).setLabel("Äá»“ng Ã½").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`proposal:no:${id}`).setLabel("Tá»« chá»‘i").setStyle(ButtonStyle.Danger),
  );
  return message.reply({ embeds: [embed], components: [row], allowedMentions: { users: [message.author.id, target.id], parse: [] } });
}
async function sendGayCheck(message, args) {
  const rawId = args.find((arg) => /^\d{17,20}$/.test(arg)) || null;
  const targetId = message.mentions.users.first()?.id || rawId;
  if (!targetId) {
    return message.reply({ embeds: [errorEmbed(`DÃ¹ng \`${PREFIX}checkgay @user\` hoáº·c \`${PREFIX}checkgay ID\`.`)] });
  }

  let target;
  try {
    target = message.mentions.users.first() || await client.users.fetch(targetId);
  } catch {
    return message.reply({ embeds: [errorEmbed("KhÃ´ng tÃ¬m tháº¥y ngÆ°á»i dÃ¹ng Discord cÃ³ ID nÃ y.")] });
  }

  const score = Math.floor(Math.random() * 101);
  const verdict = score >= 50
    ? `Káº¿t luáº­n: **${target.username} gay ${score}% â€” xÃ¡c nháº­n lÃ  gay!**`
    : `Káº¿t luáº­n: **${target.username} chá»‰ gay ${score}% â€” khÃ´ng gay!**`;
  const embed = baseEmbed(
    "MÃ¡y check gay",
    `${target}\n\n${scoreBar(score)}\n\n${verdict}`,
    score >= 50 ? 0x9b5de5 : 0x4cc9f0
  )
    .setThumbnail(target.displayAvatarURL({ size: 256 }))
    .setFooter({ text: "Káº¿t quáº£ ngáº«u nhiÃªn chá»‰ Ä‘á»ƒ giáº£i trÃ­" });

  return message.reply({
    embeds: [embed],
    allowedMentions: { users: [target.id], parse: [] },
  });
}
async function sendLoveCheck(message, args) {
  const rawId = args.find((arg) => /^\d{17,20}$/.test(arg)) || null;
  const targetId = message.mentions.users.first()?.id || rawId;
  if (!targetId) {
    return message.reply({ embeds: [errorEmbed(`DÃ¹ng \`${PREFIX}checklove @user\` hoáº·c \`${PREFIX}checklove ID\`.`)] });
  }

  let target;
  try {
    target = message.mentions.users.first() || await client.users.fetch(targetId);
  } catch {
    return message.reply({ embeds: [errorEmbed("KhÃ´ng tÃ¬m tháº¥y ngÆ°á»i dÃ¹ng Discord cÃ³ ID nÃ y.")] });
  }

  const partnerId = partnerIdOf(target.id);
  const description = partnerId
    ? `${target} **Ä‘ang cÃ³ ngÆ°á»i yÃªu** lÃ  <@${partnerId}>. Äá»«ng chen vÃ o chuyá»‡n tÃ¬nh cá»§a ngÆ°á»i ta nhÃ©!`
    : `${target} hiá»‡n Ä‘ang **Ä‘á»™c thÃ¢n**. CÆ¡ há»™i váº«n cÃ²n â€” máº¡nh dáº¡n tá» tÃ¬nh Ä‘i!`;
  const embed = baseEmbed("Kiá»ƒm tra tÃ¬nh tráº¡ng tÃ¬nh cáº£m", description, partnerId ? 0xff4f9a : 0x4cc9f0)
    .setThumbnail(target.displayAvatarURL({ size: 256 }));
  return message.reply({
    embeds: [embed],
    allowedMentions: { users: partnerId ? [target.id, partnerId] : [target.id], parse: [] },
  });
}
async function sendIntimacy(message) {
  const partnerId = partnerIdOf(message.author.id);
  if (!partnerId) return message.reply({ embeds: [errorEmbed("Báº¡n chÆ°a cÃ³ ngÆ°á»i yÃªu nÃªn chÆ°a cÃ³ Ä‘iá»ƒm thÃ¢n máº­t.")] });
  const { record } = intimacyRecord(message.author.id, partnerId);
  saveIntimacy();
  const info = intimacyLevel(record.total);
  const nextText = info.next ? `${record.total}/${info.next} Ä‘iá»ƒm Ä‘á»ƒ lÃªn cáº¥p tiáº¿p theo` : "ÄÃ£ Ä‘áº¡t cáº¥p cao nháº¥t";
  const embed = baseEmbed(
    "Cáº¥p Ä‘á»™ tÃ¬nh yÃªu",
    `${message.author} vÃ  <@${partnerId}>\n\n**Cáº¥p ${info.level} â€” ${info.name}**\n${nextText}`,
    0xff4f9a,
  ).addFields(
    { name: "Tá»•ng thÃ¢n máº­t", value: `${record.total} Ä‘iá»ƒm`, inline: true },
    { name: "HÃ´m nay", value: `${record.daily}/${DAILY_INTIMACY_LIMIT}`, inline: true },
    { name: "Giá»›i háº¡n", value: `${DAILY_INTIMACY_LIMIT} Ä‘iá»ƒm/ngÃ y`, inline: true },
  );
  return message.reply({ embeds: [embed], allowedMentions: { users: [message.author.id, partnerId], parse: [] } });
}

async function sendCheat(message, args) {
  const partnerId = partnerIdOf(message.author.id);
  if (!partnerId) return message.reply({ embeds: [errorEmbed("Báº¡n Ä‘ang Ä‘á»™c thÃ¢n thÃ¬ ngoáº¡i tÃ¬nh vá»›i ai Ä‘Æ°á»£c?")] });
  const { target, error } = getTarget(message, args);
  if (error) return message.reply({ embeds: [errorEmbed(`DÃ¹ng \`${PREFIX}ngoaitinh @user\` Ä‘á»ƒ chá»n Ä‘á»‘i tÆ°á»£ng.`)] });
  if (target.id === partnerId) return message.reply({ embeds: [errorEmbed("ÄÃ³ lÃ  ngÆ°á»i yÃªu báº¡n, nhÆ° váº­y khÃ´ng gá»i lÃ  ngoáº¡i tÃ¬nh.")] });
  if (target.bot) return message.reply({ embeds: [errorEmbed("Äá»«ng kÃ©o bot vÃ o drama tÃ¬nh cáº£m nÃ y.")] });
const rel = relationshipData(message.author.id, partnerId);
  const pledged = rel.pledgeUntil && new Date(rel.pledgeUntil).getTime() > Date.now();
  rel.stats.ngoaitinh = (rel.stats.ngoaitinh || 0) + 1;
  rel.lastCheat = { cheaterId: message.author.id, targetId: target.id, victimId: partnerId, at: new Date().toISOString(), resolved: false };
  rel.diary.push({ at: new Date().toISOString(), text: `${message.author.username} bá»‹ phÃ¡t hiá»‡n ngoáº¡i tÃ¬nh vá»›i ${target.username}.` });
  let penalty = 0;
  if (pledged) {
    const { record } = intimacyRecord(message.author.id, partnerId);
    penalty = Math.min(30, record.total);
    record.total -= penalty;
    rel.pledgeUntil = null;
    rel.pledgeDays = null;
    rel.pledgeOwner = null;
    saveIntimacy();
  }
  saveLoveData();
  const media = await randomAnime("kiss", "kiss");
  const lines = [
    `${message.author} vá»«a lÃ©n lÃºt háº¹n hÃ² vá»›i ${target} sau lÆ°ng <@${partnerId}>. Drama báº¯t Ä‘áº§u rá»“i!`,
    `${message.author} bá»‹ báº¯t gáº·p Ä‘ang tháº£ thÃ­nh ${target}. <@${partnerId}> Ä‘Ã£ nháº­n Ä‘Æ°á»£c tÃ­n hiá»‡u bÃ¡o Ä‘á»™ng!`,
    `${message.author} vÃ  ${target} vá»«a cÃ³ má»™t cuá»™c gáº·p Ä‘Ã¡ng ngá». KhÃ´ng biáº¿t <@${partnerId}> sáº½ nÃ³i gÃ¬ Ä‘Ã¢y?`,
  ];
  const embed = baseEmbed("BÃ¡o Ä‘á»™ng ngoáº¡i tÃ¬nh", randomOf(lines), 0xd90429)
    .setFooter({ text: pledged ? `ÄÃ£ phÃ¡ cam Ä‘oan Â· trá»« ${penalty} Ä‘iá»ƒm thÃ¢n máº­t` : "TÃ¬nh huá»‘ng meme Â· chá» ngÆ°á»i yÃªu dÃ¹ng .ghen/.tha-thu/.khong-tha-thu" });
  if (media?.url) embed.setImage(media.url);
  return message.reply({ embeds: [embed], allowedMentions: { users: [message.author.id, target.id, partnerId], parse: [] } });
}
function lastCheatFor(userId) {
  const current = currentRelationship(userId);
  return current?.rel.lastCheat ? { ...current, event: current.rel.lastCheat } : null;
}

async function sendRival(message) {
  const data = lastCheatFor(message.author.id);
  if (!data?.event) return message.reply({ embeds: [errorEmbed("Má»‘i quan há»‡ chÆ°a cÃ³ Ä‘á»‘i thá»§ nÃ o Ä‘Æ°á»£c ghi nháº­n.")] });
  const e = data.event;
  return message.reply({ embeds: [baseEmbed("Há»“ sÆ¡ Ä‘á»‘i thá»§", `<@${e.cheaterId}> tá»«ng ngoáº¡i tÃ¬nh vá»›i <@${e.targetId}> vÃ o **${formatDate(e.at)}**.\nTá»•ng sá»‘ láº§n ngoáº¡i tÃ¬nh: **${data.rel.stats.ngoaitinh || 0}**\nTráº¡ng thÃ¡i vá»¥ gáº§n nháº¥t: **${e.resolved ? "ÄÃ£ giáº£i quyáº¿t" : "ChÆ°a giáº£i quyáº¿t"}**`, 0xd90429)], allowedMentions: { users: [e.cheaterId, e.targetId], parse: [] } });
}

async function sendJealous(message) {
  const data = lastCheatFor(message.author.id);
  if (!data?.event || data.event.victimId !== message.author.id || data.event.resolved) return message.reply({ embeds: [errorEmbed("KhÃ´ng cÃ³ vá»¥ ngoáº¡i tÃ¬nh chÆ°a giáº£i quyáº¿t dÃ nh cho báº¡n.")] });
  const media = await randomAnime("angry", "angry");
  const embed = baseEmbed("CÆ¡n ghen ná»•i lÃªn", `${message.author} Ä‘ang cháº¥t váº¥n <@${data.event.cheaterId}> vá» chuyá»‡n vá»›i <@${data.event.targetId}>.\nDÃ¹ng \`.tha-thu\` hoáº·c \`.khong-tha-thu\` Ä‘á»ƒ quyáº¿t Ä‘á»‹nh.`, 0xe63946);
  if (media?.url) embed.setImage(media.url);
  return message.reply({ embeds: [embed], allowedMentions: { users: [message.author.id, data.event.cheaterId, data.event.targetId], parse: [] } });
}

async function forgiveCheat(message) {
  const data = lastCheatFor(message.author.id);
  if (!data?.event || data.event.victimId !== message.author.id || data.event.resolved) return message.reply({ embeds: [errorEmbed("KhÃ´ng cÃ³ chuyá»‡n nÃ o Ä‘ang chá» báº¡n tha thá»©.")] });
  const { record } = intimacyRecord(message.author.id, data.partnerId);
  const penalty = Math.min(10, record.total);
  record.total -= penalty;
  data.event.resolved = true;
  addDiary(message.author.id, data.partnerId, `${message.author.username} Ä‘Ã£ tha thá»© vá»¥ ngoáº¡i tÃ¬nh, tÃ¬nh yÃªu máº¥t ${penalty} Ä‘iá»ƒm.`);
  saveIntimacy();
  saveLoveData();
  const media = await randomAnime("hug", "hug");
  const embed = baseEmbed("ÄÃ£ tha thá»©", `${message.author} quyáº¿t Ä‘á»‹nh cho <@${data.event.cheaterId}> má»™t cÆ¡ há»™i ná»¯a. Cáº·p Ä‘Ã´i máº¥t **${penalty} Ä‘iá»ƒm thÃ¢n máº­t**.`, 0x52b788);
  if (media?.url) embed.setImage(media.url);
  return message.reply({ embeds: [embed], allowedMentions: { users: [message.author.id, data.event.cheaterId], parse: [] } });
}

async function sendPledge(message, args) {
  const current = currentRelationship(message.author.id);
  if (!current) return message.reply({ embeds: [errorEmbed("Báº¡n cáº§n cÃ³ ngÆ°á»i yÃªu má»›i cam Ä‘oan Ä‘Æ°á»£c.")] });
  const rel = current.rel;
  if (rel.pledgeUntil) {
    const until = new Date(rel.pledgeUntil).getTime();
    if (until > Date.now()) return message.reply({ embeds: [errorEmbed(`Cam Ä‘oan váº«n cÃ²n hiá»‡u lá»±c tá»›i ${formatDate(rel.pledgeUntil)}.`)] });
    if (rel.pledgeOwner === message.author.id) {
      const reward = Math.max(20, (rel.pledgeDays || 1) * 20);
      userData(message.author.id).coins += reward;
      const progress = addIntimacy(message.author.id, current.partnerId, 10);
      rel.pledgeUntil = null; rel.pledgeDays = null; rel.pledgeOwner = null;
      addDiary(message.author.id, current.partnerId, `${message.author.username} hoÃ n thÃ nh cam Ä‘oan chung thá»§y vÃ  nháº­n thÆ°á»Ÿng.`);
      saveLoveData();
      return message.reply({ embeds: [baseEmbed("HoÃ n thÃ nh cam Ä‘oan", `${message.author} nháº­n **${reward} coin** vÃ  **${progress.gained} Ä‘iá»ƒm thÃ¢n máº­t**.`, 0x52b788)] });
    }
    return message.reply({ embeds: [errorEmbed("NgÆ°á»i láº­p cam Ä‘oan cáº§n tá»± nháº­n pháº§n thÆ°á»Ÿng trÆ°á»›c.")] });
  }
  const days = Math.min(30, Math.max(1, Number.parseInt(args[0], 10) || 7));
  rel.pledgeUntil = new Date(Date.now() + days * 86_400_000).toISOString();
  rel.pledgeDays = days;
  rel.pledgeOwner = message.author.id;
  addDiary(message.author.id, current.partnerId, `${message.author.username} cam Ä‘oan chung thá»§y trong ${days} ngÃ y.`);
  return message.reply({ embeds: [baseEmbed("Cam Ä‘oan chung thá»§y", `${message.author} cam káº¿t khÃ´ng ngoáº¡i tÃ¬nh vá»›i <@${current.partnerId}> trong **${days} ngÃ y**.\nHoÃ n thÃ nh: nháº­n **${days * 20} coin** vÃ  tá»‘i Ä‘a **10 Ä‘iá»ƒm**. PhÃ¡ cam Ä‘oan: máº¥t 30 Ä‘iá»ƒm.`, 0x4361ee)], allowedMentions: { users: [message.author.id, current.partnerId], parse: [] } });
}
function breakupRow(ownerId, partnerId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`breakup:yes:${ownerId}:${partnerId}`).setLabel("XÃ¡c nháº­n chia tay").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`breakup:no:${ownerId}:${partnerId}`).setLabel("Há»§y").setStyle(ButtonStyle.Secondary),
  );
}

async function rejectCheat(message) {
  const data = lastCheatFor(message.author.id);
  if (!data?.event || data.event.victimId !== message.author.id || data.event.resolved) return message.reply({ embeds: [errorEmbed("KhÃ´ng cÃ³ vá»¥ ngoáº¡i tÃ¬nh nÃ o Ä‘ang chá» quyáº¿t Ä‘á»‹nh cá»§a báº¡n.")] });
  data.event.resolved = true;
  saveLoveData();
  return askBreakup(message);
}
async function askBreakup(message) {
  const partnerId = partnerIdOf(message.author.id);
  if (!partnerId) return message.reply({ embeds: [errorEmbed("Báº¡n Ä‘ang Ä‘á»™c thÃ¢n nÃªn chÆ°a thá»ƒ chia tay ai cáº£.")] });
  return message.reply({
    embeds: [baseEmbed("XÃ¡c nháº­n chia tay", `${message.author}, báº¡n cÃ³ cháº¯c muá»‘n káº¿t thÃºc vá»›i <@${partnerId}>? Äiá»ƒm thÃ¢n máº­t vÃ  dá»¯ liá»‡u cáº·p Ä‘Ã´i sáº½ bá»‹ xÃ³a.`, 0xd90429)],
    components: [breakupRow(message.author.id, partnerId)],
    allowedMentions: { users: [message.author.id, partnerId], parse: [] },
  });
}
const GIFTS = {
  hoa: { name: "BÃ³ hoa", price: 50, points: 5 },
  gau: { name: "Gáº¥u bÃ´ng", price: 100, points: 10 },
  socola: { name: "Há»™p socola", price: 140, points: 12 },
  nhan: { name: "Chiáº¿c nháº«n", price: 250, points: 20 },
  kem: { name: "Ly kem đôi", price: 70, points: 6 },
  banh: { name: "Bánh tình yêu", price: 90, points: 8 },
  nuochoa: { name: "Nước hoa", price: 180, points: 15 },
  vong: { name: "Vòng tay đôi", price: 220, points: 18 },
  album: { name: "Album kỷ niệm", price: 300, points: 24 },
  dienhoa: { name: "Điện thoại mới", price: 650, points: 35 },
  chuyendi: { name: "Chuyến du lịch đôi", price: 900, points: 45 },
  nhanvip: { name: "Nhẫn kim cương", price: 1500, points: 60 },
};

const DATE_PLACES = {
  bien: { name: "bÃ£i biá»ƒn", category: "handhold", text: "ngáº¯m hoÃ ng hÃ´n vÃ  Ä‘i chÃ¢n tráº§n bÃªn sÃ³ng biá»ƒn" },
  cafe: { name: "quÃ¡n cafÃ©", category: "sip", text: "ngá»“i cáº¡nh cá»­a sá»•, chia nhau má»™t mÃ³n ngá»t" },
  rapphim: { name: "ráº¡p phim", category: "cuddle", text: "xem má»™t bá»™ phim tÃ¬nh cáº£m vÃ  lÃ©n náº¯m tay nhau" },
  "cong vien": { name: "cÃ´ng viÃªn", category: "handhold", fallback: "handhold", text: "dáº¡o bá»™ dÆ°á»›i hÃ ng cÃ¢y vÃ  chá»¥p tháº­t nhiá»u áº£nh" },
};

function currentRelationship(userId) {
  const partnerId = partnerIdOf(userId);
  return partnerId ? { partnerId, rel: relationshipData(userId, partnerId) } : null;
}

async function sendProfile(message) {
  const current = currentRelationship(message.author.id);
  if (!current) return message.reply({ embeds: [errorEmbed("Báº¡n Ä‘ang Ä‘á»™c thÃ¢n nÃªn chÆ°a cÃ³ há»“ sÆ¡ cáº·p Ä‘Ã´i.")] });
  const { partnerId, rel } = current;
  const { record } = intimacyRecord(message.author.id, partnerId);
  const level = intimacyLevel(record.total);
  const partner = await client.users.fetch(partnerId).catch(() => null);
  const nickname = rel.nicknames[partnerId] || "ChÆ°a Ä‘áº·t";
  const embed = baseEmbed("Há»“ sÆ¡ tÃ¬nh yÃªu", `${message.author} Ã— <@${partnerId}>`, 0xff4f9a)
    .addFields(
      { name: "Tráº¡ng thÃ¡i", value: rel.status, inline: true },
      { name: "Báº¯t Ä‘áº§u", value: `${formatDate(rel.startedAt)} Â· ${daysTogether(rel.startedAt)} ngÃ y`, inline: true },
      { name: "ThÃ¢n máº­t", value: `Cáº¥p ${level.level} â€” ${level.name}\n${record.total} Ä‘iá»ƒm`, inline: true },
      { name: "Biá»‡t danh ngÆ°á»i yÃªu", value: nickname, inline: true },
      { name: "Coin cá»§a báº¡n", value: `${userData(message.author.id).coins || 0}`, inline: true },
    );
  if (partner) embed.setThumbnail(partner.displayAvatarURL({ size: 256 }));
  saveLoveData();
  return message.reply({ embeds: [embed], allowedMentions: { users: [message.author.id, partnerId], parse: [] } });
}

async function sendAnniversary(message) {
  const current = currentRelationship(message.author.id);
  if (!current) return message.reply({ embeds: [errorEmbed("Báº¡n chÆ°a cÃ³ ngÆ°á»i yÃªu Ä‘á»ƒ tÃ­nh ngÃ y ká»· niá»‡m.")] });
  const { partnerId, rel } = current;
  const days = daysTogether(rel.startedAt);
  const media = await randomAnime("handhold", "handhold");
  const embed = baseEmbed("NgÃ y ká»· niá»‡m", `${message.author} vÃ  <@${partnerId}> Ä‘Ã£ bÃªn nhau **${days} ngÃ y** ká»ƒ tá»« **${formatDate(rel.startedAt)}**.`, 0xff85a1);
  if (media?.url) embed.setImage(media.url);
  return message.reply({ embeds: [embed], allowedMentions: { users: [message.author.id, partnerId], parse: [] } });
}

async function sendDaily(message) {
  const user = userData(message.author.id);
  const today = intimacyDay();
  if (user.lastDaily === today) return message.reply({ embeds: [errorEmbed("Báº¡n Ä‘Ã£ nháº­n quÃ  hÃ´m nay rá»“i. Quay láº¡i vÃ o ngÃ y mai nhÃ©.")] });
  const coins = 60 + Math.floor(Math.random() * 41);
  user.coins = (user.coins || 0) + coins;
  user.lastDaily = today;
  let bonus = "";
  const partnerId = partnerIdOf(message.author.id);
  if (partnerId) {
    const progress = addIntimacy(message.author.id, partnerId, 3);
    bonus = `\nCáº·p Ä‘Ã´i nháº­n thÃªm **${progress.gained} Ä‘iá»ƒm thÃ¢n máº­t**.`;
  }
  saveLoveData();
  return message.reply({ embeds: [baseEmbed("QuÃ  háº±ng ngÃ y", `${message.author} nháº­n Ä‘Æ°á»£c **${coins} coin**.${bonus}\nSá»‘ dÆ°: **${user.coins} coin**`, 0xffc857)] });
}

function shopEmbed() {
  return baseEmbed("Cá»­a hÃ ng tÃ¬nh yÃªu", "DÃ¹ng `.tangqua <mÃ³n>` Ä‘á»ƒ mua vÃ  táº·ng tháº³ng cho ngÆ°á»i yÃªu.", 0xffc857)
    .addFields(...Object.entries(GIFTS).map(([id, gift]) => ({ name: `${gift.name} â€” ${gift.price} coin`, value: `\`${id}\` Â· +${gift.points} Ä‘iá»ƒm thÃ¢n máº­t`, inline: true })));
}

async function sendGift(message, args) {
  const current = currentRelationship(message.author.id);
  if (!current) return message.reply({ embeds: [errorEmbed("Báº¡n cáº§n cÃ³ ngÆ°á»i yÃªu má»›i táº·ng quÃ  Ä‘Æ°á»£c.")] });
  const giftId = String(args[0] || "").toLowerCase();
  const gift = GIFTS[giftId];
  if (!gift) return message.reply({ embeds: [shopEmbed()] });
  const user = userData(message.author.id);
  if ((user.coins || 0) < gift.price) return message.reply({ embeds: [errorEmbed(`Báº¡n cáº§n ${gift.price} coin nhÆ°ng hiá»‡n chá»‰ cÃ³ ${user.coins || 0}.`)] });
  user.coins -= gift.price;
  const { partnerId, rel } = current;
  const progress = addIntimacy(message.author.id, partnerId, gift.points);
  rel.gifts[giftId] = (rel.gifts[giftId] || 0) + 1;
  rel.stats.tangqua = (rel.stats.tangqua || 0) + 1;
  rel.diary.push({ at: new Date().toISOString(), text: `${message.author.username} táº·ng ${gift.name}.` });
  saveLoveData();
  const media = await randomAnime("happy", "smile");
  const embed = baseEmbed("MÃ³n quÃ  tÃ¬nh yÃªu", `${message.author} Ä‘Ã£ táº·ng **${gift.name}** cho <@${partnerId}>.\n+${progress.gained} Ä‘iá»ƒm thÃ¢n máº­t Â· cÃ²n **${user.coins} coin**`, 0xffc857);
  if (media?.url) embed.setImage(media.url);
  return message.reply({ embeds: [embed], allowedMentions: { users: [message.author.id, partnerId], parse: [] } });
}

async function sendInteractionStats(message) {
  const current = currentRelationship(message.author.id);
  if (!current) return message.reply({ embeds: [errorEmbed("Báº¡n chÆ°a cÃ³ dá»¯ liá»‡u tÆ°Æ¡ng tÃ¡c cáº·p Ä‘Ã´i.")] });
  const { partnerId, rel } = current;
  const s = rel.stats;
  return message.reply({ embeds: [baseEmbed("Thá»‘ng kÃª tÆ°Æ¡ng tÃ¡c", `${message.author} Ã— <@${partnerId}>`, 0xff6fae).addFields(
    { name: "HÃ´n", value: `${s.hon || 0}`, inline: true }, { name: "Ã”m", value: `${s.om || 0}`, inline: true },
    { name: "Náº¯m tay", value: `${s.namtay || 0}`, inline: true }, { name: "Háº¹n hÃ²", value: `${s.henho || 0}`, inline: true },
    { name: "Táº·ng quÃ ", value: `${s.tangqua || 0}`, inline: true }, { name: "Ngoáº¡i tÃ¬nh", value: `${s.ngoaitinh || 0}`, inline: true },
  )], allowedMentions: { users: [message.author.id, partnerId], parse: [] } });
}

async function sendTopLove(message) {
  await message.guild.members.fetch().catch(() => null);
  const seen = new Set();
  const rows = [];
  for (const [userId, partnerId] of Object.entries(couples)) {
    const key = coupleKey(userId, partnerId);
    if (seen.has(key)) continue;
    seen.add(key);
    if (!message.guild.members.cache.has(userId) || !message.guild.members.cache.has(partnerId)) continue;
    const total = intimacy[key]?.total || 0;
    rows.push({ userId, partnerId, total, status: relationshipData(userId, partnerId).status });
  }
  rows.sort((a, b) => b.total - a.total);
  const text = rows.slice(0, 10).map((row, i) => `**${i + 1}.** <@${row.userId}> Ã— <@${row.partnerId}> â€” **${row.total}** Ä‘iá»ƒm Â· ${row.status}`).join("\n");
  return message.reply({ embeds: [baseEmbed("Top tÃ¬nh yÃªu server", text || "Server chÆ°a cÃ³ cáº·p Ä‘Ã´i nÃ o trong báº£ng xáº¿p háº¡ng.", 0xff477e)], allowedMentions: { parse: [] } });
}

async function sendDiary(message) {
  const current = currentRelationship(message.author.id);
  let diary;
  let title = "Nháº­t kÃ½ tÃ¬nh yÃªu";
  if (current) {
    diary = current.rel.diary;
  } else {
    const archive = loveData.archives[message.author.id]?.at(-1);
    if (!archive) return message.reply({ embeds: [errorEmbed("Báº¡n chÆ°a cÃ³ nháº­t kÃ½ tÃ¬nh yÃªu.")] });
    diary = archive.diary;
    title = "Nháº­t kÃ½ má»‘i tÃ¬nh gáº§n nháº¥t";
  }
  const entries = diary.slice(-10).reverse();
  const text = entries.map((entry) => `**${formatDate(entry.at)}** â€” ${entry.text}`).join("\n") || "Nháº­t kÃ½ váº«n cÃ²n trá»‘ng.";
  return message.reply({ embeds: [baseEmbed(title, text, 0xc77dff)] });
}
async function setPartnerNickname(message, args) {
  const current = currentRelationship(message.author.id);
  if (!current) return message.reply({ embeds: [errorEmbed("Báº¡n chÆ°a cÃ³ ngÆ°á»i yÃªu Ä‘á»ƒ Ä‘áº·t biá»‡t danh.")] });
  const nickname = args.join(" ").trim().slice(0, 32);
  if (!nickname) return message.reply({ embeds: [errorEmbed(`DÃ¹ng \`${PREFIX}bietdanh <tÃªn gá»i>\`.`)] });
  current.rel.nicknames[current.partnerId] = nickname;
  addDiary(message.author.id, current.partnerId, `${message.author.username} Ä‘áº·t biá»‡t danh ngÆ°á»i yÃªu lÃ  â€œ${nickname}â€.`);
  return message.reply({ embeds: [baseEmbed("ÄÃ£ Ä‘áº·t biá»‡t danh", `Tá»« giá» ${message.author} gá»i <@${current.partnerId}> lÃ  **${nickname}**.`, 0xff85a1)], allowedMentions: { users: [message.author.id, current.partnerId], parse: [] } });
}

async function sendDate(message, args) {
  const current = currentRelationship(message.author.id);
  if (!current) return message.reply({ embeds: [errorEmbed("Báº¡n cáº§n cÃ³ ngÆ°á»i yÃªu má»›i Ä‘i háº¹n hÃ² Ä‘Æ°á»£c.")] });
  const raw = args.join(" ").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z ]/g, "").trim();
  const aliases = { beach: "bien", coffee: "cafe", cinema: "rapphim", rap: "rapphim", park: "cong vien", cong: "cong vien" };
  const key = DATE_PLACES[raw] ? raw : aliases[raw];
  const place = key ? DATE_PLACES[key] : randomOf(Object.values(DATE_PLACES));
  const progress = addIntimacy(message.author.id, current.partnerId, 5);
  current.rel.stats.henho = (current.rel.stats.henho || 0) + 1;
  current.rel.diary.push({ at: new Date().toISOString(), text: `Hai ngÆ°á»i háº¹n hÃ² táº¡i ${place.name}.` });
  saveLoveData();
  const media = await randomAnime(place.category, place.fallback || "handhold");
  const embed = baseEmbed("Buá»•i háº¹n hÃ²", `${message.author} Ä‘Æ°a <@${current.partnerId}> tá»›i **${place.name}** Ä‘á»ƒ ${place.text}.\n+${progress.gained} Ä‘iá»ƒm thÃ¢n máº­t.`, 0xff6fae);
  if (media?.url) embed.setImage(media.url);
  return message.reply({ embeds: [embed], allowedMentions: { users: [message.author.id, current.partnerId], parse: [] } });
}

async function sendLoveCard(message) {
  const current = currentRelationship(message.author.id);
  if (!current) return message.reply({ embeds: [errorEmbed("Báº¡n chÆ°a cÃ³ ngÆ°á»i yÃªu Ä‘á»ƒ lÃ m thiá»‡p ká»· niá»‡m.")] });
  const partner = await client.users.fetch(current.partnerId).catch(() => null);
  const { record } = intimacyRecord(message.author.id, current.partnerId);
  const embed = baseEmbed("Thiá»‡p ká»· niá»‡m tÃ¬nh yÃªu", `${message.author} Ã— <@${current.partnerId}>\n\n*â€œ${randomOf(QUOTES)}â€*\n\nBÃªn nhau **${daysTogether(current.rel.startedAt)} ngÃ y** Â· **${record.total} Ä‘iá»ƒm thÃ¢n máº­t**`, 0xff2e63)
    .setThumbnail(message.author.displayAvatarURL({ size: 256 }));
  if (partner) embed.setImage(partner.displayAvatarURL({ size: 512 }));
  return message.reply({ embeds: [embed], allowedMentions: { users: [message.author.id, current.partnerId], parse: [] } });
}

async function sendCoupleQuote(message) {
  const current = currentRelationship(message.author.id);
  if (!current) return message.reply({ embeds: [errorEmbed("Báº¡n chÆ°a cÃ³ ngÆ°á»i yÃªu Ä‘á»ƒ nháº­n cÃ¢u tÃ¬nh yÃªu riÃªng.")] });
  const media = await randomAnime("smile", "smile");
  const embed = baseEmbed("Lá»i dÃ nh riÃªng cho hai ngÆ°á»i", `${message.author} vÃ  <@${current.partnerId}>\n\n*â€œ${randomOf(QUOTES)}â€*`, 0xff85a1);
  if (media?.url) embed.setImage(media.url);
  return message.reply({ embeds: [embed], allowedMentions: { users: [message.author.id, current.partnerId], parse: [] } });
}
const casinoCooldowns = new Map();
const RED_NUMBERS = new Set([1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36]);
const SLOT_SYMBOLS = ["🍒", "🍋", "🍇", "🔔", "💎", "7️⃣"];

function casinoUser(userId) {
  const user = userData(userId);
  user.casino ||= { played: 0, won: 0, wagered: 0, profit: 0 };
  return user;
}

function parseWager(message, raw) {
  const user = casinoUser(message.author.id);
  const balance = Math.max(0, Math.floor(Number(user.coins) || 0));
  const value = String(raw || "").toLowerCase();
  let bet = value === "all" || value === "allin" ? balance : value === "half" || value === "nua" ? Math.floor(balance / 2) : Number(value);
  bet = Math.floor(bet);
  if (!Number.isSafeInteger(bet) || bet < 10) return { error: "Mức cược tối thiểu là **10 coin**." };
  if (bet > 1_000_000) return { error: "Mỗi ván chỉ được cược tối đa **1.000.000 coin**." };
  if (bet > balance) return { error: `Bạn chỉ có **${balance} coin**.` };
  return { user, bet, balance };
}

function casinoReady(userId) {
  const now = Date.now();
  const until = casinoCooldowns.get(userId) || 0;
  if (until > now) return false;
  casinoCooldowns.set(userId, now + 1200);
  return true;
}

function settleCasino(user, bet, payout) {
  const paid = Math.max(0, Math.floor(payout));
  const net = paid - bet;
  user.coins = Math.max(0, Math.floor((user.coins || 0) - bet + paid));
  user.casino.played += 1;
  user.casino.wagered += bet;
  user.casino.profit += net;
  if (net > 0) user.casino.won += 1;
  saveLoveData();
  return { net, balance: user.coins };
}

function casinoResultEmbed(title, result, detail, color = 0xf4a261) {
  const verdict = result.net > 0 ? `Thắng **+${result.net} coin**` : result.net === 0 ? "Hòa vốn" : `Thua **${Math.abs(result.net)} coin**`;
  return baseEmbed(title, `${detail}\n\n${verdict} · Số dư: **${result.balance} coin**`, result.net > 0 ? 0x2ecc71 : result.net === 0 ? 0xf1c40f : 0xe74c3c);
}

async function sendCasinoDaily(message) {
  const user = casinoUser(message.author.id);
  const today = intimacyDay();
  if (user.lastDailyTx === today) return message.reply({ embeds: [errorEmbed("Bạn đã nhận `.dailytx` hôm nay rồi.")] });
  const yesterday = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh" }).format(new Date(Date.now() - 86_400_000));
  user.txStreak = user.lastDailyTx === yesterday ? Math.min(7, (user.txStreak || 0) + 1) : 1;
  const reward = 180 + Math.floor(Math.random() * 121) + user.txStreak * 20;
  user.coins = (user.coins || 0) + reward;
  user.lastDailyTx = today;
  saveLoveData();
  return message.reply({ embeds: [baseEmbed("Lộc casino hằng ngày", `${message.author} nhận **${reward} coin**.\nChuỗi điểm danh: **${user.txStreak}/7 ngày** · Số dư: **${user.coins} coin**`, 0xf4a261)] });
}

async function sendBalance(message) {
  const user = casinoUser(message.author.id), c = user.casino;
  return message.reply({ embeds: [baseEmbed("Ví casino", `${message.author} đang có **${user.coins || 0} coin**.`, 0xf4a261).addFields(
    { name: "Số ván", value: `${c.played}`, inline: true }, { name: "Ván thắng", value: `${c.won}`, inline: true }, { name: "Lãi/lỗ", value: `${c.profit >= 0 ? "+" : ""}${c.profit} coin`, inline: true }
  )] });
}

async function playTaiXiu(message, args) {
  const choice = String(args[0] || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  if (!["tai", "xiu"].includes(choice)) return message.reply({ embeds: [errorEmbed("Dùng `.tx tai 100` hoặc `.tx xiu 100`.")] });
  const wager = parseWager(message, args[1]); if (wager.error) return message.reply({ embeds: [errorEmbed(wager.error)] });
  if (!casinoReady(message.author.id)) return message.reply({ embeds: [errorEmbed("Chậm tay một chút, mỗi ván cách nhau 1,2 giây.")] });
  const dice = [1,2,3].map(() => 1 + Math.floor(Math.random() * 6));
  const total = dice.reduce((a,b) => a+b, 0), triple = new Set(dice).size === 1;
  const side = total >= 11 ? "tai" : "xiu";
  const win = !triple && side === choice;
  const result = settleCasino(wager.user, wager.bet, win ? wager.bet * 2 : 0);
  return message.reply({ embeds: [casinoResultEmbed("Tài xỉu", result, `🎲 **${dice.join(" · ")}** = **${total}** — ${triple ? "Bộ ba, nhà cái ăn" : side.toUpperCase()}`)] });
}

async function playCoinflip(message, args) {
  const aliases = { ngua: "ngua", heads: "ngua", sap: "sap", tails: "sap" };
  const choice = aliases[String(args[0] || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")];
  if (!choice) return message.reply({ embeds: [errorEmbed("Dùng `.coinflip ngua 100` hoặc `.coinflip sap 100`.")] });
  const wager = parseWager(message, args[1]); if (wager.error) return message.reply({ embeds: [errorEmbed(wager.error)] });
  if (!casinoReady(message.author.id)) return;
  const landed = Math.random() < .5 ? "ngua" : "sap";
  const result = settleCasino(wager.user, wager.bet, landed === choice ? wager.bet * 2 : 0);
  return message.reply({ embeds: [casinoResultEmbed("Tung đồng xu", result, `Đồng xu rơi vào mặt **${landed === "ngua" ? "NGỬA" : "SẤP"}**.`)] });
}

async function playSlots(message, args) {
  const wager = parseWager(message, args[0]); if (wager.error) return message.reply({ embeds: [errorEmbed(wager.error)] });
  if (!casinoReady(message.author.id)) return;
  const reels = [0,1,2].map(() => SLOT_SYMBOLS[Math.floor(Math.random() * SLOT_SYMBOLS.length)]);
  const counts = reels.map(x => reels.filter(y => y === x).length), triple = counts[0] === 3, pair = Math.max(...counts) === 2;
  let multiplier = pair ? 1.3 : 0;
  if (triple) multiplier = reels[0] === "7️⃣" ? 12 : reels[0] === "💎" ? 8 : 5;
  const result = settleCasino(wager.user, wager.bet, wager.bet * multiplier);
  return message.reply({ embeds: [casinoResultEmbed("Máy xèng", result, `╔ ${reels.join(" │ ")} ╗\nHệ số thưởng: **x${multiplier}**`)] });
}

async function playDice(message, args) {
  const guess = Number(args[0]);
  if (!Number.isInteger(guess) || guess < 1 || guess > 6) return message.reply({ embeds: [errorEmbed("Dùng `.dice <số 1-6> <coin>`, ví dụ `.dice 4 100`.")] });
  const wager = parseWager(message, args[1]); if (wager.error) return message.reply({ embeds: [errorEmbed(wager.error)] });
  if (!casinoReady(message.author.id)) return;
  const rolled = 1 + Math.floor(Math.random() * 6);
  const result = settleCasino(wager.user, wager.bet, rolled === guess ? wager.bet * 5.7 : 0);
  return message.reply({ embeds: [casinoResultEmbed("Đoán xúc xắc", result, `Bạn chọn **${guess}**, xúc xắc ra **${rolled}**. Trúng được **x5.7**.`)] });
}

async function playRoulette(message, args) {
  const raw = String(args[0] || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const aliases = { do:"red", red:"red", den:"black", black:"black", chan:"even", even:"even", le:"odd", odd:"odd" };
  const choice = aliases[raw] || (/^\d+$/.test(raw) && Number(raw) <= 36 ? Number(raw) : null);
  if (choice === null || choice === undefined) return message.reply({ embeds: [errorEmbed("Dùng `.roulette do|den|chan|le|0-36 <coin>`.")] });
  const wager = parseWager(message, args[1]); if (wager.error) return message.reply({ embeds: [errorEmbed(wager.error)] });
  if (!casinoReady(message.author.id)) return;
  const number = Math.floor(Math.random() * 37), color = number === 0 ? "green" : RED_NUMBERS.has(number) ? "red" : "black";
  const win = typeof choice === "number" ? number === choice : choice === color || (choice === "even" && number !== 0 && number % 2 === 0) || (choice === "odd" && number % 2 === 1);
  const multiplier = typeof choice === "number" ? 36 : 2;
  const result = settleCasino(wager.user, wager.bet, win ? wager.bet * multiplier : 0);
  const colorName = color === "red" ? "ĐỎ" : color === "black" ? "ĐEN" : "XANH";
  return message.reply({ embeds: [casinoResultEmbed("Roulette", result, `Bi lăn vào **${number} ${colorName}**${win ? ` — trúng x${multiplier}` : ""}.`)] });
}

function helpMenu(ownerId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`help:casino:${ownerId}`).setLabel("Cờ bạc").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`help:love:${ownerId}`).setLabel("Tình yêu").setStyle(ButtonStyle.Danger),
  );
}
function helpHomeEmbed() { return baseEmbed("LoveBot — Chọn danh mục", "Chọn một trong hai nút bên dưới để xem đúng nhóm lệnh, không còn một bảng dài bị lặp.", 0xff4f9a); }
function casinoHelpEmbed() { return baseEmbed("Cờ bạc — Danh sách lệnh", "Mọi trò dùng chung coin với `.daily` và cửa hàng tình yêu.", 0xf4a261).addFields(
  { name:"Ví và vốn", value:"`.coin` · `.dailytx` · cược hỗ trợ số coin, `half`, `all`" },
  { name:"Tài xỉu", value:"`.tx tai 100` · `.tx xiu 100` — bộ ba nhà cái ăn" },
  { name:"Đồng xu", value:"`.coinflip ngua 100` · `.coinflip sap 100`" },
  { name:"Máy xèng", value:"`.slots 100` — cặp hoàn nhẹ, bộ ba x5 đến x12" },
  { name:"Roulette", value:"`.roulette do 100` · `den/chan/le` · hoặc số `0-36`" },
  { name:"Đoán xúc xắc", value:"`.dice 4 100` — đoán đúng một mặt nhận x5.7" }
).setFooter({text:"Cược tối thiểu 10 · tối đa 1.000.000 coin/ván"}); }
function loveHelpEmbed() { return baseEmbed("Tình yêu — Danh sách lệnh", `Prefix: ${PREFIX}`, 0xff4f9a).addFields(
  { name:"Cặp đôi", value:"`.profile` · `.anniversary` · `.thanmat` · `.tuongtac` · `.nhatky` · `.bietdanh`" },
  { name:"Tương tác", value:"`.hon` · `.om` · `.auyem` · `.xoa` · `.namtay` · `.qhtd` · `.henho`" },
  { name:"Quà", value:"`.daily` · `.cuahang` · `.tangqua <món>`" },
  { name:"Quan hệ", value:"`.tohtinh` · `.cauhon` · `.chiatay` · `.checklove` · `.toplove`" },
  { name:"Ghép đôi", value:"`.love` · `.ship` · `.timduyen` · `.checkgay` · `.lovequote` · `.ky-niem`" },
  { name:"Drama", value:"`.ngoaitinh` · `.doithu` · `.ghen` · `.tha-thu` · `.khong-tha-thu` · `.camdoan`" }
); }
client.once(Events.ClientReady, (readyClient) => {
  console.log(`LoveBot online: ${readyClient.user.tag}`);
  readyClient.user.setActivity(`${PREFIX}help Â· lan tá»a yÃªu thÆ°Æ¡ng`);
});

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot || !message.guild || !message.content.startsWith(PREFIX)) return;
  const body = message.content.slice(PREFIX.length).trim();
  if (!body) return;
  const [rawCommand, ...args] = body.split(/\s+/);
  const command = rawCommand.toLowerCase();
  try {
    if (command === "help" || command === "lenh") return message.reply({ embeds: [helpHomeEmbed()], components: [helpMenu(message.author.id)] });
    if (command === "coin" || command === "balance" || command === "sodu") return sendBalance(message);
    if (command === "dailytx") return sendCasinoDaily(message);
    if (command === "tx" || command === "taixiu") return playTaiXiu(message, args);
    if (command === "coinflip" || command === "cf") return playCoinflip(message, args);
    if (command === "slots" || command === "slot") return playSlots(message, args);
    if (command === "roulette" || command === "rl") return playRoulette(message, args);
    if (command === "dice" || command === "xucxac") return playDice(message, args);
    if (command === "profile") return sendProfile(message);
    if (command === "anniversary" || command === "kyniemngay") return sendAnniversary(message);
    if (command === "daily") return sendDaily(message);
    if (command === "cuahang" || command === "shop") return message.reply({ embeds: [shopEmbed()] });
    if (command === "tangqua") return sendGift(message, args);
    if (command === "tuongtac") return sendInteractionStats(message);
    if (command === "toplove") return sendTopLove(message);
    if (command === "nhatky") return sendDiary(message);
    if (command === "bietdanh") return setPartnerNickname(message, args);
    if (command === "henho") return sendDate(message, args);
    if (command === "ky-niem" || command === "kyniem") return sendLoveCard(message);
    if (command === "lovequote") return sendCoupleQuote(message);
    if (command === "doithu") return sendRival(message);
    if (command === "ghen") return sendJealous(message);
    if (command === "tha-thu" || command === "thathu") return forgiveCheat(message);
    if (command === "khong-tha-thu" || command === "khongthathu") return rejectCheat(message);
    if (command === "camdoan") return sendPledge(message, args);
    if (command === "checkgay") return sendGayCheck(message, args);
    if (command === "checklove") return sendLoveCheck(message, args);
    if (ACTIONS[command]) return sendAction(message, command);
    if (command === "ship" || command === "ghepdoi") return sendShip(message);
    if (command === "timduyen") return findSoulmate(message);
    if (command === "love" || command === "tinhyeu") return sendLove(message);
    if (command === "cauhon" || command === "marry") return sendProposal(message);
    if (command === "ngoaitinh") return sendCheat(message, args);
    if (command === "thanmat" || command === "level") return sendIntimacy(message);
    if (command === "chiatay" || command === "breakup") return askBreakup(message);
    if (command === "tohtinh") {
      const { target, error } = getTarget(message, args);
      if (error) return message.reply({ embeds: [errorEmbed(error)] });
      if (partnerIdOf(message.author.id)) return message.reply({ embeds: [errorEmbed("Báº¡n Ä‘ang cÃ³ ngÆ°á»i yÃªu nÃªn khÃ´ng thá»ƒ tá» tÃ¬nh vá»›i ngÆ°á»i khÃ¡c. HÃ£y `.chiatay` trÆ°á»›c.")] });
      const targetPartnerId = partnerIdOf(target.id);
      if (targetPartnerId) return message.reply({ embeds: [errorEmbed(`${target} Ä‘ang cÃ³ ngÆ°á»i yÃªu lÃ  <@${targetPartnerId}>, khÃ´ng thá»ƒ nháº­n lá»i tá» tÃ¬nh.`)], allowedMentions: { users: [target.id, targetPartnerId], parse: [] } });
      const media = await randomAnime("blush", "blush");
      const embed = baseEmbed("Má»™t lá»i tá»« trÃ¡i tim", `${target}, ${message.author} muá»‘n nÃ³i ráº±ng:\n\n**â€œTá»› thÃ­ch cáº­u. KhÃ´ng pháº£i nháº¥t thá»i, mÃ  lÃ  má»—i ngÃ y Ä‘á»u thÃ­ch thÃªm má»™t chÃºt.â€**`, 0xff477e);
      if (media?.url) embed.setImage(media.url);
      return message.reply({ embeds: [embed], allowedMentions: { users: [message.author.id, target.id], parse: [] } });
    }
    if (command === "quote" || command === "tinhca") {
      const quote = QUOTES[Math.floor(Math.random() * QUOTES.length)];
      const media = await randomAnime("smile", "smile");
      const embed = baseEmbed("Lá»i yÃªu hÃ´m nay", `*â€œ${quote}â€*`, 0xff85a1);
      if (media?.url) embed.setImage(media.url);
      return message.reply({ embeds: [embed] });
    }
    return message.reply({ embeds: [errorEmbed(`KhÃ´ng cÃ³ lá»‡nh \`${PREFIX}${command}\`. GÃµ \`${PREFIX}help\` Ä‘á»ƒ xem lá»‡nh.`)] });
  } catch (error) {
    console.error("[command]", error);
    return message.reply({ embeds: [errorEmbed("CÃ³ lá»—i khi gá»i GIF hoáº·c gá»­i embed. Thá»­ láº¡i má»™t láº§n ná»¯a nhÃ©.")] }).catch(() => {});
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isButton()) return;
  if (interaction.customId.startsWith("help:")) {
    const [, page, ownerId] = interaction.customId.split(":");
    if (interaction.user.id !== ownerId) return interaction.reply({ embeds: [errorEmbed("Hãy tự gõ `.help` để mở menu của bạn.")], ephemeral: true });
    const embed = page === "casino" ? casinoHelpEmbed() : loveHelpEmbed();
    return interaction.update({ embeds: [embed], components: [helpMenu(ownerId)] });
  }
  if (interaction.customId.startsWith("breakup:")) {
    const [, answer, ownerId, expectedPartnerId] = interaction.customId.split(":");
    if (interaction.user.id !== ownerId) return interaction.reply({ embeds: [errorEmbed("Chá»‰ ngÆ°á»i yÃªu cáº§u chia tay má»›i Ä‘Æ°á»£c báº¥m nÃºt nÃ y.")], ephemeral: true });
    if (answer === "no") return interaction.update({ embeds: [baseEmbed("ÄÃ£ há»§y", "Hai ngÆ°á»i váº«n tiáº¿p tá»¥c bÃªn nhau.", 0x52b788)], components: [] });
    const partnerId = partnerIdOf(ownerId);
    if (!partnerId || partnerId !== expectedPartnerId) return interaction.update({ embeds: [errorEmbed("Quan há»‡ Ä‘Ã£ thay Ä‘á»•i nÃªn xÃ¡c nháº­n nÃ y khÃ´ng cÃ²n hiá»‡u lá»±c.")], components: [] });
    const media = await randomAnime("cry", "cry");
    removeCouple(ownerId);
    const embed = baseEmbed("ÄÃ£ chia tay", `<@${ownerId}> vÃ  <@${partnerId}> Ä‘Ã£ chÃ­nh thá»©c Ä‘Æ°á»ng ai náº¥y Ä‘i. Äiá»ƒm vÃ  dá»¯ liá»‡u cáº·p Ä‘Ã´i Ä‘Ã£ Ä‘Æ°á»£c xÃ³a.`, 0x778da9);
    if (media?.url) embed.setImage(media.url);
    return interaction.update({ embeds: [embed], components: [], allowedMentions: { users: [ownerId, partnerId], parse: [] } });
  }
  if (!interaction.customId.startsWith("proposal:")) return;
  const [, answer, id] = interaction.customId.split(":");
  const proposal = proposals.get(id);
  if (!proposal || proposal.expiresAt <= Date.now()) {
    proposals.delete(id);
    return interaction.reply({ embeds: [errorEmbed("Lá»i cáº§u hÃ´n nÃ y Ä‘Ã£ háº¿t háº¡n.")], ephemeral: true });
  }
  if (interaction.user.id !== proposal.targetId) {
    return interaction.reply({ embeds: [errorEmbed("KhÃ´ng pháº£i lá»i cáº§u hÃ´n dÃ nh cho báº¡n.")], ephemeral: true });
  }
  proposals.delete(id);
  const accepted = answer === "yes";
  if (accepted && proposal.kind === "new") {
    if (partnerIdOf(proposal.proposerId) || partnerIdOf(proposal.targetId)) {
      return interaction.update({ embeds: [errorEmbed("Má»™t trong hai ngÆ°á»i Ä‘Ã£ cÃ³ má»‘i quan há»‡ nÃªn lá»i nÃ y khÃ´ng cÃ²n há»£p lá»‡.")], components: [] });
    }
    setCouple(proposal.proposerId, proposal.targetId);
    const rel = relationshipData(proposal.proposerId, proposal.targetId);
    const total = intimacyRecord(proposal.proposerId, proposal.targetId).record.total;
    if (total < proposal.requiredPoints) return interaction.update({ embeds: [errorEmbed(`Äiá»ƒm thÃ¢n máº­t Ä‘Ã£ giáº£m dÆ°á»›i ${proposal.requiredPoints}, chÆ°a thá»ƒ nÃ¢ng cáº¥p.`)], components: [] });
    rel.status = proposal.nextStatus;
    rel.diary[0].text = `Hai ngÆ°á»i báº¯t Ä‘áº§u á»Ÿ tráº¡ng thÃ¡i ${proposal.nextStatus}.`;
    saveLoveData();
  } else if (accepted && proposal.kind === "upgrade") {
    if (partnerIdOf(proposal.proposerId) !== proposal.targetId || partnerIdOf(proposal.targetId) !== proposal.proposerId) {
      return interaction.update({ embeds: [errorEmbed("Má»‘i quan há»‡ Ä‘Ã£ thay Ä‘á»•i nÃªn lá»i nÃ¢ng cáº¥p khÃ´ng cÃ²n há»£p lá»‡.")], components: [] });
    }
    const rel = relationshipData(proposal.proposerId, proposal.targetId);
    const total = intimacyRecord(proposal.proposerId, proposal.targetId).record.total;
    if (total < proposal.requiredPoints) return interaction.update({ embeds: [errorEmbed(`Äiá»ƒm thÃ¢n máº­t Ä‘Ã£ giáº£m dÆ°á»›i ${proposal.requiredPoints}, chÆ°a thá»ƒ nÃ¢ng cáº¥p.`)], components: [] });
    rel.status = proposal.nextStatus;
    addDiary(proposal.proposerId, proposal.targetId, `Hai ngÆ°á»i chÃ­nh thá»©c chuyá»ƒn sang tráº¡ng thÃ¡i ${proposal.nextStatus}.`);
  }
  const media = await randomAnime(accepted ? "kiss" : "cry", accepted ? "kiss" : "cry");
  const embed = accepted
    ? baseEmbed("ÄÃ£ Ä‘á»“ng Ã½", `<@${proposal.targetId}> Ä‘Ã£ Ä‘á»“ng Ã½ vá»›i <@${proposal.proposerId}>. Tráº¡ng thÃ¡i má»›i: **${proposal.nextStatus}**!`, 0xff2e63)
    : baseEmbed("Lá»i há»“i Ä‘Ã¡p", `<@${proposal.targetId}> Ä‘Ã£ tá»« chá»‘i lá»i cáº§u hÃ´n cá»§a <@${proposal.proposerId}>. Buá»“n má»™t chÃºt rá»“i bÆ°á»›c tiáº¿p nhÃ©.`, 0x778da9);
  if (media?.url) embed.setImage(media.url);
  return interaction.update({ embeds: [embed], components: [], allowedMentions: { users: [proposal.targetId, proposal.proposerId], parse: [] } });
});

process.on("unhandledRejection", (error) => console.error("unhandledRejection", error));
process.on("uncaughtException", (error) => console.error("uncaughtException", error));

await initializePersistence();
await client.login(token);


