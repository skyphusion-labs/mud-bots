// discord/bot.mjs
// Discord bot that relays channel/DM messages to a local ollama model and replies.
// Maintains per-channel conversation history for context. Works across multiple servers.
//
// Required Discord Developer Portal settings (discord.com/developers/applications):
//   Bot -> Privileged Gateway Intents -> MESSAGE CONTENT: ON
//   OAuth2 -> URL Generator -> scope: bot -> permissions: Send Messages, Read Message History
//
// Config (all via env):
//   DISCORD_TOKEN          (required) bot token from the Developer Portal
//   DISCORD_CHANNEL_IDS    comma-separated channel IDs to actively listen in;
//                          if empty, only DMs and @mentions are answered
//   OLLAMA_BASE_URL        ollama OpenAI-compat base  (default http://wendy.internal:11434/v1)
//   DISCORD_MODEL          model id                   (default qwen3.6:27b-ctx8k)
//   DISCORD_SYSTEM_PROMPT  override the default system prompt
//   DISCORD_HISTORY        rolling history depth in exchange pairs (default 10)
//   DISCORD_LOG            tee logs to this file path (optional)
//
// Systemd unit template (~/.config/systemd/user/discordbot.service on the host):
//   [Unit]
//   Description=Discord Ollama Bot
//   After=network-online.target
//   [Service]
//   WorkingDirectory=%h/dev/bots/discord
//   ExecStart=node bot.mjs
//   Environment=DISCORD_TOKEN=<token>
//   Environment=DISCORD_CHANNEL_IDS=<id1,id2,...>
//   Environment=OLLAMA_BASE_URL=http://wendy.internal:11434/v1
//   Environment=DISCORD_MODEL=qwen3.6:27b-ctx8k
//   Environment=DISCORD_LOG=%h/dev/bots/discord.log
//   Restart=always
//   RestartSec=10
//   [Install]
//   WantedBy=default.target
//
// After creating the unit: systemctl --user daemon-reload && systemctl --user enable --now discordbot
//
// Requires Node 24+ (global fetch). Install deps: npm ci

import { Client, GatewayIntentBits, Partials, Events } from 'discord.js';
import { appendFileSync } from 'node:fs';

const LOG_FILE = process.env.DISCORD_LOG ?? '';

function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.join(' ')}`;
  console.log(line);
  if (LOG_FILE) try { appendFileSync(LOG_FILE, line + '\n'); } catch {}
}

if (!process.env.DISCORD_TOKEN) {
  log('ERROR: DISCORD_TOKEN is required');
  process.exit(1);
}

const CFG = {
  token: process.env.DISCORD_TOKEN,
  ollamaBase: process.env.OLLAMA_BASE_URL ?? 'http://wendy.internal:11434/v1',
  model: process.env.DISCORD_MODEL ?? 'qwen3.6:27b-ctx8k',
  // channelIds: set of channel IDs to listen in; empty = DMs + @mentions only
  channelIds: new Set((process.env.DISCORD_CHANNEL_IDS ?? '').split(',').filter(Boolean)),
  // historyLen: number of exchange PAIRS (user+assistant) to keep per channel
  historyLen: parseInt(process.env.DISCORD_HISTORY ?? '10', 10),
  systemPrompt: process.env.DISCORD_SYSTEM_PROMPT ??
    'You are a helpful AI assistant participating in a Discord server. ' +
    'Be concise, conversational, and friendly. ' +
    'Messages will include the sender\'s name so you know who said what.',
};

log(`Starting: model=${CFG.model} base=${CFG.ollamaBase} channels=${CFG.channelIds.size || 'DMs+mentions only'}`);

// Per-channel rolling conversation history.
// Key: channelId, value: [{role, content}] (system excluded; prepended on each call)
const history = new Map();

function getHistory(channelId) {
  if (!history.has(channelId)) history.set(channelId, []);
  return history.get(channelId);
}

function appendHistory(channelId, role, content) {
  const h = getHistory(channelId);
  h.push({ role, content });
  // rolling window: keep at most historyLen pairs (2 entries each)
  while (h.length > CFG.historyLen * 2) h.shift();
}

// Reasoning models (qwen3, deepseek-r1) emit <think>...</think> blocks before the answer.
// Strip them so Discord only sees the clean reply.
function stripThink(text) {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

async function askOllama(channelId, userContent) {
  const messages = [
    { role: 'system', content: CFG.systemPrompt },
    ...getHistory(channelId),
    { role: 'user', content: userContent },
  ];

  const res = await fetch(`${CFG.ollamaBase}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ollama' },
    body: JSON.stringify({ model: CFG.model, messages, stream: false }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`ollama ${res.status}: ${body}`);
  }

  const data = await res.json();
  const raw = data.choices?.[0]?.message?.content ?? '';
  return stripThink(raw) || '(no response)';
}

// Split a long reply into Discord-safe chunks (<= 2000 chars), breaking at newlines.
function splitMessage(text, limit = 1990) {
  if (text.length <= limit) return [text];
  const chunks = [];
  while (text.length > 0) {
    let slice = text.slice(0, limit);
    const lastNl = slice.lastIndexOf('\n');
    // prefer breaking at a newline if one exists past the halfway mark
    if (lastNl > limit * 0.5) slice = text.slice(0, lastNl + 1);
    chunks.push(slice.trimEnd());
    text = text.slice(slice.length).trimStart();
  }
  return chunks.filter(Boolean);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,  // privileged -- must be ON in the Developer Portal
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel, Partials.Message],  // required for uncached DM channels
});

client.once(Events.ClientReady, (c) => {
  log(`Ready: ${c.user.tag} (${c.guilds.cache.size} guild(s))`);
});

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;

  const isDM = !message.guild;
  const isMentioned = message.mentions.has(client.user);
  const inListenChannel = CFG.channelIds.size > 0 && CFG.channelIds.has(message.channelId);

  if (!isDM && !isMentioned && !inListenChannel) return;

  // Strip our own @mention from the text so the model doesn't see the raw snowflake ID
  const userText = message.content
    .replace(new RegExp(`<@!?${client.user.id}>`, 'g'), '')
    .trim();

  if (!userText) return;

  const channelId = message.channelId;
  const authorName = message.member?.displayName ?? message.author.username;
  const channelLabel = isDM ? 'DM' : `${message.guild.name}/#${message.channel.name ?? channelId}`;

  log(`[${channelLabel}] ${authorName}: ${userText.slice(0, 120)}`);

  // Show typing indicator; keep it alive every 8s since reasoning models can be slow
  try { await message.channel.sendTyping(); } catch {}
  const typingInterval = setInterval(() => {
    message.channel.sendTyping().catch(() => {});
  }, 8000);

  try {
    // Include author name so the model can track who said what in group chats
    const userContent = `${authorName}: ${userText}`;
    const reply = await askOllama(channelId, userContent);

    appendHistory(channelId, 'user', userContent);
    appendHistory(channelId, 'assistant', reply);

    log(`-> ${reply.slice(0, 120)}${reply.length > 120 ? '...' : ''}`);

    const chunks = splitMessage(reply);
    for (const chunk of chunks) {
      await message.reply(chunk);
    }
  } catch (err) {
    log(`ERROR: ${err.message}`);
    await message.reply(`(ollama error: ${err.message})`).catch(() => {});
  } finally {
    clearInterval(typingInterval);
  }
});

// Clear history on !reset (useful for starting a fresh conversation)
client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;
  if (message.content.trim() !== '!reset') return;
  const isDM = !message.guild;
  const isMentioned = message.mentions.has(client.user);
  const inListenChannel = CFG.channelIds.size > 0 && CFG.channelIds.has(message.channelId);
  if (!isDM && !isMentioned && !inListenChannel) return;

  history.delete(message.channelId);
  log(`[${message.channelId}] history cleared by ${message.author.username}`);
  await message.reply('Conversation history cleared.').catch(() => {});
});

client.login(CFG.token);
