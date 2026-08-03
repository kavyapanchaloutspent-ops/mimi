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
if (!token) throw new Error("Thiếu DISCORD_TOKEN");

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
  if (points >= 600) return { level: 6, name: "Định mệnh trọn đời", next: null };
  if (points >= 300) return { level: 5, name: "Không thể tách rời", next: 600 };
  if (points >= 150) return { level: 4, name: "Yêu sâu đậm", next: 300 };
  if (points >= 75) return { level: 3, name: "Quấn nhau không rời", next: 150 };
  if (points >= 30) return { level: 2, name: "Đang say nắng", next: 75 };
  return { level: 1, name: "Mới yêu", next: 30 };
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
    console.warn("[storage] DATABASE_URL chưa có, đang dùng JSON cục bộ.");
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
    console.log("[postgres] Đã tải dữ liệu tình yêu từ PostgreSQL.");
  } else {
    persistState();
    await persistenceQueue;
    console.log("[postgres] Đã nhập dữ liệu JSON hiện tại vào PostgreSQL.");
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
      status: "Đang yêu",
      nicknames: {},
      stats: { hon: 0, om: 0, namtay: 0, henho: 0, tangqua: 0, ngoaitinh: 0 },
      diary: [{ at: new Date().toISOString(), text: "Hai người bắt đầu mối quan hệ." }],
      gifts: {},
      lastCheat: null,
      pledgeUntil: null,
    };
  }
  const rel = loveData.relationships[key] || null;
  if (rel) {
    rel.startedAt ||= new Date().toISOString();
    rel.status ||= "Đang yêu";
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
    oldRel.diary.push({ at: new Date().toISOString(), text: "Hai người đã chia tay." });
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
  hon: { category: "kiss", color: 0xff4f9a, verb: "đã hôn", ending: "một nụ hôn thấm thía đến muốn tan chảy" },
  kiss: { category: "kiss", color: 0xff4f9a, verb: "đã hôn", ending: "một nụ hôn ngọt đến sâu răng" },
  om: { category: "hug", color: 0xff8bbd, verb: "đã ôm", ending: "chặt đến mức mọi buồn phiền bay sạch" },
  hug: { category: "hug", color: 0xff8bbd, verb: "đã ôm", ending: "ấm hơn cả chăn mùa đông" },
  auyem: { category: "cuddle", color: 0xf59bd0, verb: "đã âu yếm", ending: "dịu dàng như cảnh cuối phim tình cảm" },
  cuddle: { category: "cuddle", color: 0xf59bd0, verb: "đã ôm ấp", ending: "và nhất quyết không chịu buông" },
  xoa: { category: "pat", color: 0xffb4d7, verb: "đã xoa đầu", ending: "ngoan nào, hôm nay vất vả rồi" },
  pat: { category: "pat", color: 0xffb4d7, verb: "đã xoa đầu", ending: "nhẹ nhàng hết mức có thể" },
  namtay: { category: "handhold", color: 0xff6fae, verb: "đã nắm tay", ending: "rồi kéo nhau đi qua cả thế giới" },
  highfive: { category: "highfive", color: 0xffcc70, verb: "đã đập tay", ending: "một phát cực ăn ý" },
  choc: { category: "poke", color: 0xff8a9e, verb: "đã chọc", ending: "cho đến khi người kia đỏ mặt" },
  poke: { category: "poke", color: 0xff8a9e, verb: "đã chọc", ending: "vì đáng yêu quá chịu không nổi" },
  can: { category: "bite", color: 0xe76f8a, verb: "đã cắn", ending: "một cái để đánh dấu chủ quyền" },
  bite: { category: "bite", color: 0xe76f8a, verb: "đã cắn yêu", ending: "nhưng chắc chắn không đau đâu" },
  tho: { category: "blush", color: 0xff9eb5, verb: "đã làm", ending: "đỏ mặt đến mức không dám nhìn thẳng" },
  nhay: { category: "dance", color: 0xc77dff, verb: "đã kéo", ending: "vào một điệu nhảy chỉ dành cho hai người" },
  honmuah: { category: "blowkiss", fallback: "kiss", color: 0xff5d8f, verb: "đã gửi nụ hôn gió tới", ending: "bay thẳng vào tim" },
  qhtd: { category: "cuddle", fallback: "kiss", color: 0xb5179e, verb: "đã kéo", ending: "vào không gian riêng tư rồi nhẹ nhàng đóng cửa lại" },
};

const QUOTES = [
  "Yêu không cần hoàn hảo, chỉ cần hai người không bỏ cuộc.",
  "Giữa hàng triệu người, gặp đúng nhau đã là một phép màu.",
  "Bình yên đôi khi chỉ là có một người chịu nghe mình kể chuyện mỗi ngày.",
  "Tình yêu đẹp nhất là khi cả hai vẫn chọn nhau sau những ngày không đẹp.",
  "Không cần đi đâu xa, nơi có người thương chính là nhà.",
  "Có những cái nắm tay ngắn thôi nhưng đủ làm ấm cả một ngày dài.",
  "Thích một người là tự nhiên thấy mọi bài tình ca đều có tên họ.",
  "Nếu trái tim có thông báo, chắc tên người ấy đang hiện liên tục.",
];

const ACTION_VARIANTS = {
  hon: [
    "một nụ hôn thật lâu như muốn giữ cả thế giới lại",
    "một nụ hôn ngọt đến mức tim muốn nhảy khỏi lồng ngực",
    "một nụ hôn bất ngờ làm người kia đỏ bừng cả mặt",
    "một nụ hôn dịu dàng như cảnh cuối phim tình cảm",
    "một nụ hôn thắm thiết khiến thời gian như đứng yên",
  ],
  kiss: [
    "một nụ hôn ngọt ngào không muốn rời",
    "một nụ hôn vụng trộm nhưng đầy thương nhớ",
    "một nụ hôn nhẹ lên môi thay cho ngàn lời muốn nói",
  ],
  om: [
    "thật chặt để mọi buồn phiền bay sạch",
    "vào lòng như thể đã nhớ nhau cả một đời",
    "ấm áp đến mức chẳng ai muốn buông tay",
    "từ phía sau và thủ thỉ rằng mọi chuyện rồi sẽ ổn",
    "một cái thật lâu để sạc đầy năng lượng yêu thương",
  ],
  hug: [
    "ấm hơn cả chiếc chăn giữa mùa đông",
    "chặt đến mức nghe được nhịp tim của nhau",
    "dịu dàng như đang ôm điều quý giá nhất",
  ],
  auyem: ["dịu dàng đến tan chảy", "thật lâu dưới ánh nhìn đầy yêu thương", "nhẹ nhàng như sợ làm người kia tổn thương"],
  cuddle: ["và nhất quyết không chịu buông", "trong vòng tay ấm áp nhất", "đến khi cả hai cùng ngủ quên"],
  xoa: ["rồi bảo hôm nay vất vả rồi", "nhẹ nhàng như dỗ dành một chú mèo", "kèm một ánh mắt đầy cưng chiều"],
  pat: ["nhẹ nhàng hết mức có thể", "để thưởng cho sự đáng yêu", "và khen ngoan thật khẽ"],
  namtay: ["rồi kéo nhau đi qua cả thế giới", "thật chặt như một lời hứa", "và không định buông ra nữa"],
  honmuah: ["bay thẳng vào tim", "kèm theo cả một trời thương nhớ", "làm người nhận đỏ mặt ngay lập tức"],
  qhtd: ["vào phòng riêng rồi đóng cửa — phần sau xin phép để trí tưởng tượng lên tiếng", "đi tâm sự riêng trong bầu không khí cực kỳ đáng ngờ", "biến mất sau cánh cửa cùng tấm biển miễn làm phiền", "đi hẹn hò phiên bản giới hạn người xem"],
};

const PROPOSAL_LINES = [
  "Cậu có đồng ý cùng tớ viết tiếp câu chuyện này, từ hôm nay cho đến thật lâu về sau không?",
  "Thế giới rộng như vậy, cậu có muốn từ nay cùng tớ chung một lối về không?",
  "Tớ không hứa mọi ngày đều hoàn hảo, nhưng tớ hứa ngày nào cũng sẽ chọn cậu. Đồng ý nhé?",
  "Cho tớ một đặc quyền: được ở cạnh, chăm sóc và thương cậu thật lâu, được không?",
  "Từ lần đầu gặp cậu, tớ đã muốn tương lai của mình có tên cậu. Cậu đồng ý chứ?",
  "Tớ đã tìm thấy người muốn nắm tay đi hết chặng đường rồi. Người đó là cậu — mình yêu nhau nhé?",
  "Nếu tình yêu là một chuyến phiêu lưu, cậu có muốn làm bạn đồng hành trọn đời của tớ không?",
  "Tim tớ đã chọn cậu mất rồi. Cậu có chịu nhận lấy nó và ở bên tớ không?",
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
  return baseEmbed("Không làm được rồi", text, 0xe74c3c);
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
  if (!target && !allowSelf) return { error: "Hãy mention một người, ví dụ `.hon @người_ấy`." };
  if (target?.id === message.author.id && !allowSelf) return { error: "Tự làm với chính mình nghe cô đơn quá, mention người khác đi." };
  return { target: target || message.author, args };
}

async function sendAction(message, command) {
  const action = ACTIONS[command];
  const partnerId = partnerIdOf(message.author.id);
  if (!partnerId) {
    return message.reply({ embeds: [errorEmbed(`Bạn chưa có người yêu. Hãy dùng \`${PREFIX}cauhon @user\` và chờ người ấy đồng ý trước.`)] });
  }
  let target;
  try {
    target = await client.users.fetch(partnerId);
  } catch {
    return message.reply({ embeds: [errorEmbed("Không tìm thấy tài khoản người yêu đã lưu. Hãy thử lại sau.")] });
  }
const media = await randomAnime(action.category, action.fallback || action.category);
  const requestedPoints = command === "qhtd" ? 5 : ["hon", "kiss", "om", "hug", "auyem", "cuddle", "namtay", "honmuah"].includes(command) ? 3 : 2;
const progress = addIntimacy(message.author.id, partnerId, requestedPoints);
  const stat = ["hon", "kiss", "honmuah"].includes(command) ? "hon" : ["om", "hug", "auyem", "cuddle"].includes(command) ? "om" : command === "namtay" ? "namtay" : command;
  const rel = relationshipData(message.author.id, partnerId);
  rel.stats[stat] = (rel.stats[stat] || 0) + 1;
  if ((rel.lastLevel || 1) < progress.level) {
    rel.lastLevel = progress.level;
    rel.diary.push({ at: new Date().toISOString(), text: `Tình yêu đạt cấp ${progress.level}: ${progress.name}.` });
  }
  saveLoveData();
  const lines = [
    `${message.author} **${action.verb}** ${target} — ${randomOf(ACTION_VARIANTS[command] || [action.ending])}.`,
    `-# ${QUOTES[Math.floor(Math.random() * QUOTES.length)]}`,
  ];
  const embed = baseEmbed("Một chút yêu thương", lines.join("\n\n"), action.color)
    .setFooter({ text: `Yêu cầu bởi ${message.author.username}` });
embed.addFields(
    { name: "Thân mật", value: progress.gained ? `+${progress.gained} điểm · tổng **${progress.total}**` : `Đã đạt giới hạn **${DAILY_INTIMACY_LIMIT} điểm/ngày**`, inline: true },
    { name: `Cấp ${progress.level}`, value: progress.name, inline: true },
    { name: "Hôm nay", value: `${progress.daily}/${DAILY_INTIMACY_LIMIT} điểm`, inline: true },
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
  return `${"💗".repeat(filled)}${"🖤".repeat(10 - filled)} **${score}%**`;
}

async function sendShip(message) {
  const users = [...message.mentions.users.values()];
  const first = users[0] || message.author;
  const second = users[1] || (users[0] && users[0].id !== message.author.id ? message.author : null);
  if (!second || first.id === second.id) {
    return message.reply({ embeds: [errorEmbed("Dùng `.ship @A @B` hoặc `.ship @người_ấy`.")] });
  }
  const score = pairScore(first, second);
  const media = await randomAnime(score >= 50 ? "handhold" : "stare", "handhold");
  const verdict = score >= 90 ? "Định mệnh khóa cứng hai người rồi." : score >= 70 ? "Có mùi thành đôi rất rõ." : score >= 40 ? "Có tia lửa, cần chủ động thêm." : "Duyên đang lag, thử lại kiếp sau.";
  const embed = baseEmbed("Máy đo tình yêu", `${first} × ${second}\n\n${scoreBar(score)}\n\n**${verdict}**`, 0xff477e);
  if (media?.url) embed.setImage(media.url);
  return message.reply({ embeds: [embed], allowedMentions: { users: [first.id, second.id], parse: [] } });
}

async function sendLove(message) {
  const partnerId = partnerIdOf(message.author.id);
  if (!partnerId) {
    return message.reply({ embeds: [errorEmbed(`Bạn chưa có người yêu. Hãy dùng \`${PREFIX}cauhon @user\` trước.`)] });
  }
  const mentioned = message.mentions.users.first();
  if (mentioned && mentioned.id !== partnerId) {
    return message.reply({ embeds: [errorEmbed(`Bạn chỉ có thể dùng lệnh này với người yêu: <@${partnerId}>.`)], allowedMentions: { users: [partnerId], parse: [] } });
  }
  const target = mentioned || await client.users.fetch(partnerId);
  const score = pairScore(message.author, target);
  const embed = baseEmbed("Chỉ số rung động hôm nay", `${message.author} dành cho ${target}\n\n${scoreBar(score)}\n\n${QUOTES[score % QUOTES.length]}`, 0xff5c8a);
  const media = await randomAnime(score > 60 ? "blush" : "smile", "blush");
  if (media?.url) embed.setImage(media.url);
  return message.reply({ embeds: [embed], allowedMentions: { users: [message.author.id, target.id], parse: [] } });
}

async function sendProposal(message) {
  const { target, error } = getTarget(message, []);
  if (error) return message.reply({ embeds: [errorEmbed(error)] });
  if (target.bot) return message.reply({ embeds: [errorEmbed("Cầu hôn bot thì bot chỉ biết chúc phúc thôi.")] });

  const myPartner = partnerIdOf(message.author.id);
  const theirPartner = partnerIdOf(target.id);
  let kind = "new";
  let nextStatus = "Đang tìm hiểu";
  let requiredPoints = 0;
  if (myPartner || theirPartner) {
    if (myPartner !== target.id || theirPartner !== message.author.id) {
      return message.reply({ embeds: [errorEmbed("Một trong hai người đã có mối quan hệ khác nên không thể gửi lời này.")] });
    }
    kind = "upgrade";
    const rel = relationshipData(message.author.id, target.id);
    const total = intimacyRecord(message.author.id, target.id).record.total;
    if (rel.status === "Đang tìm hiểu") { nextStatus = "Đang yêu"; requiredPoints = 30; }
    else if (rel.status === "Đang yêu") { nextStatus = "Đính hôn"; requiredPoints = 150; }
    else if (rel.status === "Đính hôn") { nextStatus = "Kết hôn"; requiredPoints = 300; }
    else return message.reply({ embeds: [errorEmbed("Hai người đã kết hôn rồi, không thể nâng cấp thêm nữa.")] });
    if (total < requiredPoints) {
      return message.reply({ embeds: [errorEmbed(`Cần ít nhất **${requiredPoints} điểm thân mật** để chuyển từ **${rel.status}** sang **${nextStatus}**. Hiện có ${total} điểm.`)] });
    }
  }

  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  proposals.set(id, { proposerId: message.author.id, targetId: target.id, kind, nextStatus, requiredPoints, expiresAt: Date.now() + 5 * 60_000 });
  setTimeout(() => proposals.delete(id), 5 * 60_000);
  const media = await randomAnime("handhold", "kiss");
  const proposalLine = randomOf(PROPOSAL_LINES);
  const embed = baseEmbed(
    kind === "new" ? "Lời bắt đầu tình yêu" : `Lời hẹn bước sang: ${nextStatus}`,
    `${target}, ${message.author} đang lấy hết can đảm để hỏi:\n\n**“${proposalLine}”**\n\nNếu đồng ý, trạng thái sẽ là **${nextStatus}**.`,
    0xff2e63,
  ).setFooter({ text: "Chỉ người nhận được trả lời · hết hạn sau 5 phút" });
  if (media?.url) embed.setImage(media.url);
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`proposal:yes:${id}`).setLabel("Đồng ý").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`proposal:no:${id}`).setLabel("Từ chối").setStyle(ButtonStyle.Danger),
  );
  return message.reply({ embeds: [embed], components: [row], allowedMentions: { users: [message.author.id, target.id], parse: [] } });
}
async function sendGayCheck(message, args) {
  const rawId = args.find((arg) => /^\d{17,20}$/.test(arg)) || null;
  const targetId = message.mentions.users.first()?.id || rawId;
  if (!targetId) {
    return message.reply({ embeds: [errorEmbed(`Dùng \`${PREFIX}checkgay @user\` hoặc \`${PREFIX}checkgay ID\`.`)] });
  }

  let target;
  try {
    target = message.mentions.users.first() || await client.users.fetch(targetId);
  } catch {
    return message.reply({ embeds: [errorEmbed("Không tìm thấy người dùng Discord có ID này.")] });
  }

  const score = Math.floor(Math.random() * 101);
  const verdict = score >= 50
    ? `Kết luận: **${target.username} gay ${score}% — xác nhận là gay!**`
    : `Kết luận: **${target.username} chỉ gay ${score}% — không gay!**`;
  const embed = baseEmbed(
    "Máy check gay",
    `${target}\n\n${scoreBar(score)}\n\n${verdict}`,
    score >= 50 ? 0x9b5de5 : 0x4cc9f0
  )
    .setThumbnail(target.displayAvatarURL({ size: 256 }))
    .setFooter({ text: "Kết quả ngẫu nhiên chỉ để giải trí" });

  return message.reply({
    embeds: [embed],
    allowedMentions: { users: [target.id], parse: [] },
  });
}
async function sendLoveCheck(message, args) {
  const rawId = args.find((arg) => /^\d{17,20}$/.test(arg)) || null;
  const targetId = message.mentions.users.first()?.id || rawId;
  if (!targetId) {
    return message.reply({ embeds: [errorEmbed(`Dùng \`${PREFIX}checklove @user\` hoặc \`${PREFIX}checklove ID\`.`)] });
  }

  let target;
  try {
    target = message.mentions.users.first() || await client.users.fetch(targetId);
  } catch {
    return message.reply({ embeds: [errorEmbed("Không tìm thấy người dùng Discord có ID này.")] });
  }

  const partnerId = partnerIdOf(target.id);
  const description = partnerId
    ? `${target} **đang có người yêu** là <@${partnerId}>. Đừng chen vào chuyện tình của người ta nhé!`
    : `${target} hiện đang **độc thân**. Cơ hội vẫn còn — mạnh dạn tỏ tình đi!`;
  const embed = baseEmbed("Kiểm tra tình trạng tình cảm", description, partnerId ? 0xff4f9a : 0x4cc9f0)
    .setThumbnail(target.displayAvatarURL({ size: 256 }));
  return message.reply({
    embeds: [embed],
    allowedMentions: { users: partnerId ? [target.id, partnerId] : [target.id], parse: [] },
  });
}
async function sendIntimacy(message) {
  const partnerId = partnerIdOf(message.author.id);
  if (!partnerId) return message.reply({ embeds: [errorEmbed("Bạn chưa có người yêu nên chưa có điểm thân mật.")] });
  const { record } = intimacyRecord(message.author.id, partnerId);
  saveIntimacy();
  const info = intimacyLevel(record.total);
  const nextText = info.next ? `${record.total}/${info.next} điểm để lên cấp tiếp theo` : "Đã đạt cấp cao nhất";
  const embed = baseEmbed(
    "Cấp độ tình yêu",
    `${message.author} và <@${partnerId}>\n\n**Cấp ${info.level} — ${info.name}**\n${nextText}`,
    0xff4f9a,
  ).addFields(
    { name: "Tổng thân mật", value: `${record.total} điểm`, inline: true },
    { name: "Hôm nay", value: `${record.daily}/${DAILY_INTIMACY_LIMIT}`, inline: true },
    { name: "Giới hạn", value: `${DAILY_INTIMACY_LIMIT} điểm/ngày`, inline: true },
  );
  return message.reply({ embeds: [embed], allowedMentions: { users: [message.author.id, partnerId], parse: [] } });
}

async function sendCheat(message, args) {
  const partnerId = partnerIdOf(message.author.id);
  if (!partnerId) return message.reply({ embeds: [errorEmbed("Bạn đang độc thân thì ngoại tình với ai được?")] });
  const { target, error } = getTarget(message, args);
  if (error) return message.reply({ embeds: [errorEmbed(`Dùng \`${PREFIX}ngoaitinh @user\` để chọn đối tượng.`)] });
  if (target.id === partnerId) return message.reply({ embeds: [errorEmbed("Đó là người yêu bạn, như vậy không gọi là ngoại tình.")] });
  if (target.bot) return message.reply({ embeds: [errorEmbed("Đừng kéo bot vào drama tình cảm này.")] });
const rel = relationshipData(message.author.id, partnerId);
  const pledged = rel.pledgeUntil && new Date(rel.pledgeUntil).getTime() > Date.now();
  rel.stats.ngoaitinh = (rel.stats.ngoaitinh || 0) + 1;
  rel.lastCheat = { cheaterId: message.author.id, targetId: target.id, victimId: partnerId, at: new Date().toISOString(), resolved: false };
  rel.diary.push({ at: new Date().toISOString(), text: `${message.author.username} bị phát hiện ngoại tình với ${target.username}.` });
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
    `${message.author} vừa lén lút hẹn hò với ${target} sau lưng <@${partnerId}>. Drama bắt đầu rồi!`,
    `${message.author} bị bắt gặp đang thả thính ${target}. <@${partnerId}> đã nhận được tín hiệu báo động!`,
    `${message.author} và ${target} vừa có một cuộc gặp đáng ngờ. Không biết <@${partnerId}> sẽ nói gì đây?`,
  ];
  const embed = baseEmbed("Báo động ngoại tình", randomOf(lines), 0xd90429)
    .setFooter({ text: pledged ? `Đã phá cam đoan · trừ ${penalty} điểm thân mật` : "Tình huống meme · chờ người yêu dùng .ghen/.tha-thu/.khong-tha-thu" });
  if (media?.url) embed.setImage(media.url);
  return message.reply({ embeds: [embed], allowedMentions: { users: [message.author.id, target.id, partnerId], parse: [] } });
}
function lastCheatFor(userId) {
  const current = currentRelationship(userId);
  return current?.rel.lastCheat ? { ...current, event: current.rel.lastCheat } : null;
}

async function sendRival(message) {
  const data = lastCheatFor(message.author.id);
  if (!data?.event) return message.reply({ embeds: [errorEmbed("Mối quan hệ chưa có đối thủ nào được ghi nhận.")] });
  const e = data.event;
  return message.reply({ embeds: [baseEmbed("Hồ sơ đối thủ", `<@${e.cheaterId}> từng ngoại tình với <@${e.targetId}> vào **${formatDate(e.at)}**.\nTổng số lần ngoại tình: **${data.rel.stats.ngoaitinh || 0}**\nTrạng thái vụ gần nhất: **${e.resolved ? "Đã giải quyết" : "Chưa giải quyết"}**`, 0xd90429)], allowedMentions: { users: [e.cheaterId, e.targetId], parse: [] } });
}

async function sendJealous(message) {
  const data = lastCheatFor(message.author.id);
  if (!data?.event || data.event.victimId !== message.author.id || data.event.resolved) return message.reply({ embeds: [errorEmbed("Không có vụ ngoại tình chưa giải quyết dành cho bạn.")] });
  const media = await randomAnime("angry", "angry");
  const embed = baseEmbed("Cơn ghen nổi lên", `${message.author} đang chất vấn <@${data.event.cheaterId}> về chuyện với <@${data.event.targetId}>.\nDùng \`.tha-thu\` hoặc \`.khong-tha-thu\` để quyết định.`, 0xe63946);
  if (media?.url) embed.setImage(media.url);
  return message.reply({ embeds: [embed], allowedMentions: { users: [message.author.id, data.event.cheaterId, data.event.targetId], parse: [] } });
}

async function forgiveCheat(message) {
  const data = lastCheatFor(message.author.id);
  if (!data?.event || data.event.victimId !== message.author.id || data.event.resolved) return message.reply({ embeds: [errorEmbed("Không có chuyện nào đang chờ bạn tha thứ.")] });
  const { record } = intimacyRecord(message.author.id, data.partnerId);
  const penalty = Math.min(10, record.total);
  record.total -= penalty;
  data.event.resolved = true;
  addDiary(message.author.id, data.partnerId, `${message.author.username} đã tha thứ vụ ngoại tình, tình yêu mất ${penalty} điểm.`);
  saveIntimacy();
  saveLoveData();
  const media = await randomAnime("hug", "hug");
  const embed = baseEmbed("Đã tha thứ", `${message.author} quyết định cho <@${data.event.cheaterId}> một cơ hội nữa. Cặp đôi mất **${penalty} điểm thân mật**.`, 0x52b788);
  if (media?.url) embed.setImage(media.url);
  return message.reply({ embeds: [embed], allowedMentions: { users: [message.author.id, data.event.cheaterId], parse: [] } });
}

async function sendPledge(message, args) {
  const current = currentRelationship(message.author.id);
  if (!current) return message.reply({ embeds: [errorEmbed("Bạn cần có người yêu mới cam đoan được.")] });
  const rel = current.rel;
  if (rel.pledgeUntil) {
    const until = new Date(rel.pledgeUntil).getTime();
    if (until > Date.now()) return message.reply({ embeds: [errorEmbed(`Cam đoan vẫn còn hiệu lực tới ${formatDate(rel.pledgeUntil)}.`)] });
    if (rel.pledgeOwner === message.author.id) {
      const reward = Math.max(20, (rel.pledgeDays || 1) * 20);
      userData(message.author.id).coins += reward;
      const progress = addIntimacy(message.author.id, current.partnerId, 10);
      rel.pledgeUntil = null; rel.pledgeDays = null; rel.pledgeOwner = null;
      addDiary(message.author.id, current.partnerId, `${message.author.username} hoàn thành cam đoan chung thủy và nhận thưởng.`);
      saveLoveData();
      return message.reply({ embeds: [baseEmbed("Hoàn thành cam đoan", `${message.author} nhận **${reward} coin** và **${progress.gained} điểm thân mật**.`, 0x52b788)] });
    }
    return message.reply({ embeds: [errorEmbed("Người lập cam đoan cần tự nhận phần thưởng trước.")] });
  }
  const days = Math.min(30, Math.max(1, Number.parseInt(args[0], 10) || 7));
  rel.pledgeUntil = new Date(Date.now() + days * 86_400_000).toISOString();
  rel.pledgeDays = days;
  rel.pledgeOwner = message.author.id;
  addDiary(message.author.id, current.partnerId, `${message.author.username} cam đoan chung thủy trong ${days} ngày.`);
  return message.reply({ embeds: [baseEmbed("Cam đoan chung thủy", `${message.author} cam kết không ngoại tình với <@${current.partnerId}> trong **${days} ngày**.\nHoàn thành: nhận **${days * 20} coin** và tối đa **10 điểm**. Phá cam đoan: mất 30 điểm.`, 0x4361ee)], allowedMentions: { users: [message.author.id, current.partnerId], parse: [] } });
}
function breakupRow(ownerId, partnerId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`breakup:yes:${ownerId}:${partnerId}`).setLabel("Xác nhận chia tay").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`breakup:no:${ownerId}:${partnerId}`).setLabel("Hủy").setStyle(ButtonStyle.Secondary),
  );
}

async function rejectCheat(message) {
  const data = lastCheatFor(message.author.id);
  if (!data?.event || data.event.victimId !== message.author.id || data.event.resolved) return message.reply({ embeds: [errorEmbed("Không có vụ ngoại tình nào đang chờ quyết định của bạn.")] });
  data.event.resolved = true;
  saveLoveData();
  return askBreakup(message);
}
async function askBreakup(message) {
  const partnerId = partnerIdOf(message.author.id);
  if (!partnerId) return message.reply({ embeds: [errorEmbed("Bạn đang độc thân nên chưa thể chia tay ai cả.")] });
  return message.reply({
    embeds: [baseEmbed("Xác nhận chia tay", `${message.author}, bạn có chắc muốn kết thúc với <@${partnerId}>? Điểm thân mật và dữ liệu cặp đôi sẽ bị xóa.`, 0xd90429)],
    components: [breakupRow(message.author.id, partnerId)],
    allowedMentions: { users: [message.author.id, partnerId], parse: [] },
  });
}
const GIFTS = {
  hoa: { name: "Bó hoa", price: 50, points: 5 },
  gau: { name: "Gấu bông", price: 100, points: 10 },
  socola: { name: "Hộp socola", price: 140, points: 12 },
  nhan: { name: "Chiếc nhẫn", price: 250, points: 20 },
};

const DATE_PLACES = {
  bien: { name: "bãi biển", category: "handhold", text: "ngắm hoàng hôn và đi chân trần bên sóng biển" },
  cafe: { name: "quán café", category: "sip", text: "ngồi cạnh cửa sổ, chia nhau một món ngọt" },
  rapphim: { name: "rạp phim", category: "cuddle", text: "xem một bộ phim tình cảm và lén nắm tay nhau" },
  "cong vien": { name: "công viên", category: "handhold", fallback: "handhold", text: "dạo bộ dưới hàng cây và chụp thật nhiều ảnh" },
};

function currentRelationship(userId) {
  const partnerId = partnerIdOf(userId);
  return partnerId ? { partnerId, rel: relationshipData(userId, partnerId) } : null;
}

async function sendProfile(message) {
  const current = currentRelationship(message.author.id);
  if (!current) return message.reply({ embeds: [errorEmbed("Bạn đang độc thân nên chưa có hồ sơ cặp đôi.")] });
  const { partnerId, rel } = current;
  const { record } = intimacyRecord(message.author.id, partnerId);
  const level = intimacyLevel(record.total);
  const partner = await client.users.fetch(partnerId).catch(() => null);
  const nickname = rel.nicknames[partnerId] || "Chưa đặt";
  const embed = baseEmbed("Hồ sơ tình yêu", `${message.author} × <@${partnerId}>`, 0xff4f9a)
    .addFields(
      { name: "Trạng thái", value: rel.status, inline: true },
      { name: "Bắt đầu", value: `${formatDate(rel.startedAt)} · ${daysTogether(rel.startedAt)} ngày`, inline: true },
      { name: "Thân mật", value: `Cấp ${level.level} — ${level.name}\n${record.total} điểm`, inline: true },
      { name: "Biệt danh người yêu", value: nickname, inline: true },
      { name: "Coin của bạn", value: `${userData(message.author.id).coins || 0}`, inline: true },
    );
  if (partner) embed.setThumbnail(partner.displayAvatarURL({ size: 256 }));
  saveLoveData();
  return message.reply({ embeds: [embed], allowedMentions: { users: [message.author.id, partnerId], parse: [] } });
}

async function sendAnniversary(message) {
  const current = currentRelationship(message.author.id);
  if (!current) return message.reply({ embeds: [errorEmbed("Bạn chưa có người yêu để tính ngày kỷ niệm.")] });
  const { partnerId, rel } = current;
  const days = daysTogether(rel.startedAt);
  const media = await randomAnime("handhold", "handhold");
  const embed = baseEmbed("Ngày kỷ niệm", `${message.author} và <@${partnerId}> đã bên nhau **${days} ngày** kể từ **${formatDate(rel.startedAt)}**.`, 0xff85a1);
  if (media?.url) embed.setImage(media.url);
  return message.reply({ embeds: [embed], allowedMentions: { users: [message.author.id, partnerId], parse: [] } });
}

async function sendDaily(message) {
  const user = userData(message.author.id);
  const today = intimacyDay();
  if (user.lastDaily === today) return message.reply({ embeds: [errorEmbed("Bạn đã nhận quà hôm nay rồi. Quay lại vào ngày mai nhé.")] });
  const coins = 60 + Math.floor(Math.random() * 41);
  user.coins = (user.coins || 0) + coins;
  user.lastDaily = today;
  let bonus = "";
  const partnerId = partnerIdOf(message.author.id);
  if (partnerId) {
    const progress = addIntimacy(message.author.id, partnerId, 3);
    bonus = `\nCặp đôi nhận thêm **${progress.gained} điểm thân mật**.`;
  }
  saveLoveData();
  return message.reply({ embeds: [baseEmbed("Quà hằng ngày", `${message.author} nhận được **${coins} coin**.${bonus}\nSố dư: **${user.coins} coin**`, 0xffc857)] });
}

function shopEmbed() {
  return baseEmbed("Cửa hàng tình yêu", "Dùng `.tangqua <món>` để mua và tặng thẳng cho người yêu.", 0xffc857)
    .addFields(...Object.entries(GIFTS).map(([id, gift]) => ({ name: `${gift.name} — ${gift.price} coin`, value: `\`${id}\` · +${gift.points} điểm thân mật`, inline: true })));
}

async function sendGift(message, args) {
  const current = currentRelationship(message.author.id);
  if (!current) return message.reply({ embeds: [errorEmbed("Bạn cần có người yêu mới tặng quà được.")] });
  const giftId = String(args[0] || "").toLowerCase();
  const gift = GIFTS[giftId];
  if (!gift) return message.reply({ embeds: [shopEmbed()] });
  const user = userData(message.author.id);
  if ((user.coins || 0) < gift.price) return message.reply({ embeds: [errorEmbed(`Bạn cần ${gift.price} coin nhưng hiện chỉ có ${user.coins || 0}.`)] });
  user.coins -= gift.price;
  const { partnerId, rel } = current;
  const progress = addIntimacy(message.author.id, partnerId, gift.points);
  rel.gifts[giftId] = (rel.gifts[giftId] || 0) + 1;
  rel.stats.tangqua = (rel.stats.tangqua || 0) + 1;
  rel.diary.push({ at: new Date().toISOString(), text: `${message.author.username} tặng ${gift.name}.` });
  saveLoveData();
  const media = await randomAnime("happy", "smile");
  const embed = baseEmbed("Món quà tình yêu", `${message.author} đã tặng **${gift.name}** cho <@${partnerId}>.\n+${progress.gained} điểm thân mật · còn **${user.coins} coin**`, 0xffc857);
  if (media?.url) embed.setImage(media.url);
  return message.reply({ embeds: [embed], allowedMentions: { users: [message.author.id, partnerId], parse: [] } });
}

async function sendInteractionStats(message) {
  const current = currentRelationship(message.author.id);
  if (!current) return message.reply({ embeds: [errorEmbed("Bạn chưa có dữ liệu tương tác cặp đôi.")] });
  const { partnerId, rel } = current;
  const s = rel.stats;
  return message.reply({ embeds: [baseEmbed("Thống kê tương tác", `${message.author} × <@${partnerId}>`, 0xff6fae).addFields(
    { name: "Hôn", value: `${s.hon || 0}`, inline: true }, { name: "Ôm", value: `${s.om || 0}`, inline: true },
    { name: "Nắm tay", value: `${s.namtay || 0}`, inline: true }, { name: "Hẹn hò", value: `${s.henho || 0}`, inline: true },
    { name: "Tặng quà", value: `${s.tangqua || 0}`, inline: true }, { name: "Ngoại tình", value: `${s.ngoaitinh || 0}`, inline: true },
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
  const text = rows.slice(0, 10).map((row, i) => `**${i + 1}.** <@${row.userId}> × <@${row.partnerId}> — **${row.total}** điểm · ${row.status}`).join("\n");
  return message.reply({ embeds: [baseEmbed("Top tình yêu server", text || "Server chưa có cặp đôi nào trong bảng xếp hạng.", 0xff477e)], allowedMentions: { parse: [] } });
}

async function sendDiary(message) {
  const current = currentRelationship(message.author.id);
  let diary;
  let title = "Nhật ký tình yêu";
  if (current) {
    diary = current.rel.diary;
  } else {
    const archive = loveData.archives[message.author.id]?.at(-1);
    if (!archive) return message.reply({ embeds: [errorEmbed("Bạn chưa có nhật ký tình yêu.")] });
    diary = archive.diary;
    title = "Nhật ký mối tình gần nhất";
  }
  const entries = diary.slice(-10).reverse();
  const text = entries.map((entry) => `**${formatDate(entry.at)}** — ${entry.text}`).join("\n") || "Nhật ký vẫn còn trống.";
  return message.reply({ embeds: [baseEmbed(title, text, 0xc77dff)] });
}
async function setPartnerNickname(message, args) {
  const current = currentRelationship(message.author.id);
  if (!current) return message.reply({ embeds: [errorEmbed("Bạn chưa có người yêu để đặt biệt danh.")] });
  const nickname = args.join(" ").trim().slice(0, 32);
  if (!nickname) return message.reply({ embeds: [errorEmbed(`Dùng \`${PREFIX}bietdanh <tên gọi>\`.`)] });
  current.rel.nicknames[current.partnerId] = nickname;
  addDiary(message.author.id, current.partnerId, `${message.author.username} đặt biệt danh người yêu là “${nickname}”.`);
  return message.reply({ embeds: [baseEmbed("Đã đặt biệt danh", `Từ giờ ${message.author} gọi <@${current.partnerId}> là **${nickname}**.`, 0xff85a1)], allowedMentions: { users: [message.author.id, current.partnerId], parse: [] } });
}

async function sendDate(message, args) {
  const current = currentRelationship(message.author.id);
  if (!current) return message.reply({ embeds: [errorEmbed("Bạn cần có người yêu mới đi hẹn hò được.")] });
  const raw = args.join(" ").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z ]/g, "").trim();
  const aliases = { beach: "bien", coffee: "cafe", cinema: "rapphim", rap: "rapphim", park: "cong vien", cong: "cong vien" };
  const key = DATE_PLACES[raw] ? raw : aliases[raw];
  const place = key ? DATE_PLACES[key] : randomOf(Object.values(DATE_PLACES));
  const progress = addIntimacy(message.author.id, current.partnerId, 5);
  current.rel.stats.henho = (current.rel.stats.henho || 0) + 1;
  current.rel.diary.push({ at: new Date().toISOString(), text: `Hai người hẹn hò tại ${place.name}.` });
  saveLoveData();
  const media = await randomAnime(place.category, place.fallback || "handhold");
  const embed = baseEmbed("Buổi hẹn hò", `${message.author} đưa <@${current.partnerId}> tới **${place.name}** để ${place.text}.\n+${progress.gained} điểm thân mật.`, 0xff6fae);
  if (media?.url) embed.setImage(media.url);
  return message.reply({ embeds: [embed], allowedMentions: { users: [message.author.id, current.partnerId], parse: [] } });
}

async function sendLoveCard(message) {
  const current = currentRelationship(message.author.id);
  if (!current) return message.reply({ embeds: [errorEmbed("Bạn chưa có người yêu để làm thiệp kỷ niệm.")] });
  const partner = await client.users.fetch(current.partnerId).catch(() => null);
  const { record } = intimacyRecord(message.author.id, current.partnerId);
  const embed = baseEmbed("Thiệp kỷ niệm tình yêu", `${message.author} × <@${current.partnerId}>\n\n*“${randomOf(QUOTES)}”*\n\nBên nhau **${daysTogether(current.rel.startedAt)} ngày** · **${record.total} điểm thân mật**`, 0xff2e63)
    .setThumbnail(message.author.displayAvatarURL({ size: 256 }));
  if (partner) embed.setImage(partner.displayAvatarURL({ size: 512 }));
  return message.reply({ embeds: [embed], allowedMentions: { users: [message.author.id, current.partnerId], parse: [] } });
}

async function sendCoupleQuote(message) {
  const current = currentRelationship(message.author.id);
  if (!current) return message.reply({ embeds: [errorEmbed("Bạn chưa có người yêu để nhận câu tình yêu riêng.")] });
  const media = await randomAnime("smile", "smile");
  const embed = baseEmbed("Lời dành riêng cho hai người", `${message.author} và <@${current.partnerId}>\n\n*“${randomOf(QUOTES)}”*`, 0xff85a1);
  if (media?.url) embed.setImage(media.url);
  return message.reply({ embeds: [embed], allowedMentions: { users: [message.author.id, current.partnerId], parse: [] } });
}
function helpEmbed() {
  return baseEmbed("LoveBot — Danh sách lệnh", `Prefix hiện tại: \`${PREFIX}\``, 0xff4f9a)
    .addFields(
      { name: "Cặp đôi", value: "`.profile` · `.anniversary` · `.thanmat` · `.tuongtac` · `.nhatky` · `.bietdanh <tên>`" },
      { name: "Tương tác", value: "`.hon` · `.om` · `.auyem` · `.xoa` · `.namtay` · `.honmuah` · `.qhtd` · `.henho [bien/cafe/rapphim/cong vien]`" },
      { name: "Kinh tế và quà", value: "`.daily` · `.cuahang` · `.tangqua <hoa/gau/socola/nhan>`" },
      { name: "Quan hệ", value: "`.tohtinh @user` · `.cauhon @user` · `.chiatay` · `.checklove @user/ID` · `.toplove`" },
      { name: "Kỷ niệm", value: "`.ky-niem` · `.lovequote` · `.love` · `.quote` · `.ship @A @B`" },
      { name: "Drama", value: "`.ngoaitinh @user` · `.doithu` · `.ghen` · `.tha-thu` · `.khong-tha-thu` · `.camdoan [ngày]`" },
      { name: "Bói vui", value: "`.checkgay @user/ID`" },
      { name: "Trạng thái", value: "Đang tìm hiểu → Đang yêu (30đ) → Đính hôn (150đ) → Kết hôn (300đ). Dùng `.cauhon` để xin nâng cấp." },
    )
    .setFooter({ text: `Điểm thân mật tối đa ${DAILY_INTIMACY_LIMIT}/ngày · toàn bộ phản hồi bằng embed` });
}
client.once(Events.ClientReady, (readyClient) => {
  console.log(`LoveBot online: ${readyClient.user.tag}`);
  readyClient.user.setActivity(`${PREFIX}help · lan tỏa yêu thương`);
});

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot || !message.guild || !message.content.startsWith(PREFIX)) return;
  const body = message.content.slice(PREFIX.length).trim();
  if (!body) return;
  const [rawCommand, ...args] = body.split(/\s+/);
  const command = rawCommand.toLowerCase();
  try {
    if (command === "help" || command === "lenh") return message.reply({ embeds: [helpEmbed()] });
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
    if (command === "love" || command === "tinhyeu") return sendLove(message);
    if (command === "cauhon" || command === "marry") return sendProposal(message);
    if (command === "ngoaitinh") return sendCheat(message, args);
    if (command === "thanmat" || command === "level") return sendIntimacy(message);
    if (command === "chiatay" || command === "breakup") return askBreakup(message);
    if (command === "tohtinh") {
      const { target, error } = getTarget(message, args);
      if (error) return message.reply({ embeds: [errorEmbed(error)] });
      if (partnerIdOf(message.author.id)) return message.reply({ embeds: [errorEmbed("Bạn đang có người yêu nên không thể tỏ tình với người khác. Hãy `.chiatay` trước.")] });
      const targetPartnerId = partnerIdOf(target.id);
      if (targetPartnerId) return message.reply({ embeds: [errorEmbed(`${target} đang có người yêu là <@${targetPartnerId}>, không thể nhận lời tỏ tình.`)], allowedMentions: { users: [target.id, targetPartnerId], parse: [] } });
      const media = await randomAnime("blush", "blush");
      const embed = baseEmbed("Một lời từ trái tim", `${target}, ${message.author} muốn nói rằng:\n\n**“Tớ thích cậu. Không phải nhất thời, mà là mỗi ngày đều thích thêm một chút.”**`, 0xff477e);
      if (media?.url) embed.setImage(media.url);
      return message.reply({ embeds: [embed], allowedMentions: { users: [message.author.id, target.id], parse: [] } });
    }
    if (command === "quote" || command === "tinhca") {
      const quote = QUOTES[Math.floor(Math.random() * QUOTES.length)];
      const media = await randomAnime("smile", "smile");
      const embed = baseEmbed("Lời yêu hôm nay", `*“${quote}”*`, 0xff85a1);
      if (media?.url) embed.setImage(media.url);
      return message.reply({ embeds: [embed] });
    }
    return message.reply({ embeds: [errorEmbed(`Không có lệnh \`${PREFIX}${command}\`. Gõ \`${PREFIX}help\` để xem lệnh.`)] });
  } catch (error) {
    console.error("[command]", error);
    return message.reply({ embeds: [errorEmbed("Có lỗi khi gọi GIF hoặc gửi embed. Thử lại một lần nữa nhé.")] }).catch(() => {});
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isButton()) return;
  if (interaction.customId.startsWith("breakup:")) {
    const [, answer, ownerId, expectedPartnerId] = interaction.customId.split(":");
    if (interaction.user.id !== ownerId) return interaction.reply({ embeds: [errorEmbed("Chỉ người yêu cầu chia tay mới được bấm nút này.")], ephemeral: true });
    if (answer === "no") return interaction.update({ embeds: [baseEmbed("Đã hủy", "Hai người vẫn tiếp tục bên nhau.", 0x52b788)], components: [] });
    const partnerId = partnerIdOf(ownerId);
    if (!partnerId || partnerId !== expectedPartnerId) return interaction.update({ embeds: [errorEmbed("Quan hệ đã thay đổi nên xác nhận này không còn hiệu lực.")], components: [] });
    const media = await randomAnime("cry", "cry");
    removeCouple(ownerId);
    const embed = baseEmbed("Đã chia tay", `<@${ownerId}> và <@${partnerId}> đã chính thức đường ai nấy đi. Điểm và dữ liệu cặp đôi đã được xóa.`, 0x778da9);
    if (media?.url) embed.setImage(media.url);
    return interaction.update({ embeds: [embed], components: [], allowedMentions: { users: [ownerId, partnerId], parse: [] } });
  }
  if (!interaction.customId.startsWith("proposal:")) return;
  const [, answer, id] = interaction.customId.split(":");
  const proposal = proposals.get(id);
  if (!proposal || proposal.expiresAt <= Date.now()) {
    proposals.delete(id);
    return interaction.reply({ embeds: [errorEmbed("Lời cầu hôn này đã hết hạn.")], ephemeral: true });
  }
  if (interaction.user.id !== proposal.targetId) {
    return interaction.reply({ embeds: [errorEmbed("Không phải lời cầu hôn dành cho bạn.")], ephemeral: true });
  }
  proposals.delete(id);
  const accepted = answer === "yes";
  if (accepted && proposal.kind === "new") {
    if (partnerIdOf(proposal.proposerId) || partnerIdOf(proposal.targetId)) {
      return interaction.update({ embeds: [errorEmbed("Một trong hai người đã có mối quan hệ nên lời này không còn hợp lệ.")], components: [] });
    }
    setCouple(proposal.proposerId, proposal.targetId);
    const rel = relationshipData(proposal.proposerId, proposal.targetId);
    const total = intimacyRecord(proposal.proposerId, proposal.targetId).record.total;
    if (total < proposal.requiredPoints) return interaction.update({ embeds: [errorEmbed(`Điểm thân mật đã giảm dưới ${proposal.requiredPoints}, chưa thể nâng cấp.`)], components: [] });
    rel.status = proposal.nextStatus;
    rel.diary[0].text = `Hai người bắt đầu ở trạng thái ${proposal.nextStatus}.`;
    saveLoveData();
  } else if (accepted && proposal.kind === "upgrade") {
    if (partnerIdOf(proposal.proposerId) !== proposal.targetId || partnerIdOf(proposal.targetId) !== proposal.proposerId) {
      return interaction.update({ embeds: [errorEmbed("Mối quan hệ đã thay đổi nên lời nâng cấp không còn hợp lệ.")], components: [] });
    }
    const rel = relationshipData(proposal.proposerId, proposal.targetId);
    const total = intimacyRecord(proposal.proposerId, proposal.targetId).record.total;
    if (total < proposal.requiredPoints) return interaction.update({ embeds: [errorEmbed(`Điểm thân mật đã giảm dưới ${proposal.requiredPoints}, chưa thể nâng cấp.`)], components: [] });
    rel.status = proposal.nextStatus;
    addDiary(proposal.proposerId, proposal.targetId, `Hai người chính thức chuyển sang trạng thái ${proposal.nextStatus}.`);
  }
  const media = await randomAnime(accepted ? "kiss" : "cry", accepted ? "kiss" : "cry");
  const embed = accepted
    ? baseEmbed("Đã đồng ý", `<@${proposal.targetId}> đã đồng ý với <@${proposal.proposerId}>. Trạng thái mới: **${proposal.nextStatus}**!`, 0xff2e63)
    : baseEmbed("Lời hồi đáp", `<@${proposal.targetId}> đã từ chối lời cầu hôn của <@${proposal.proposerId}>. Buồn một chút rồi bước tiếp nhé.`, 0x778da9);
  if (media?.url) embed.setImage(media.url);
  return interaction.update({ embeds: [embed], components: [], allowedMentions: { users: [proposal.targetId, proposal.proposerId], parse: [] } });
});

process.on("unhandledRejection", (error) => console.error("unhandledRejection", error));
process.on("uncaughtException", (error) => console.error("uncaughtException", error));

await initializePersistence();
await client.login(token);
