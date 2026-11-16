"use strict";

const http = require("node:http");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const os = require("node:os");
const { spawn } = require("node:child_process");

const ROOT_DIR = __dirname;
const PUBLIC_DIR = path.join(ROOT_DIR, "public");
const ENV_FILE = path.join(ROOT_DIR, ".env");
const MAX_AUDIO_BYTES = 20 * 1024 * 1024;
const MAX_REQUEST_BYTES = MAX_AUDIO_BYTES + 64 * 1024;
const ALLOWED_AUDIO_MIMES = new Set(["audio/wav", "audio/ogg", "audio/mpeg", "audio/flac"]);

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon"
};

function readDotEnv() {
  const cfg = {
    PORT: "3456",
    APP_MODE: "personal",
    ROBLOX_API_KEY: "",
    ROBLOX_DEFAULT_TARGET: "user",
    ROBLOX_USER_ID: "",
    ROBLOX_GROUP_ID: ""
  };

  if (fs.existsSync(ENV_FILE)) {
    const lines = fs.readFileSync(ENV_FILE, "utf8").split(/\r?\n/);
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const eqIdx = line.indexOf("=");
      if (eqIdx < 1) continue;
      const key = line.slice(0, eqIdx).trim();
      let val = line.slice(eqIdx + 1).trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        if (val.length >= 2) val = val.slice(1, -1);
      }
      cfg[key] = val;
    }
  }

  for (const key of Object.keys(cfg)) {
    if (typeof process.env[key] === "string" && process.env[key].length > 0) {
      cfg[key] = process.env[key];
    }
  }
  return cfg;
}

function saveDotEnv(updates) {
  let lines = [];
  if (fs.existsSync(ENV_FILE)) {
    lines = fs.readFileSync(ENV_FILE, "utf8").split(/\r?\n/);
  }

  const handled = new Set();
  const nextLines = lines.map((rawLine) => {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) {
      return rawLine;
    }
    const key = trimmed.slice(0, trimmed.indexOf("=")).trim();
    if (Object.prototype.hasOwnProperty.call(updates, key)) {
      handled.add(key);
      return `${key}=${String(updates[key]).replace(/[\r\n]/g, "")}`;
    }
    return rawLine;
  });

  for (const [key, val] of Object.entries(updates)) {
    if (!handled.has(key)) {
      nextLines.push(`${key}=${String(val).replace(/[\r\n]/g, "")}`);
    }
  }

  fs.writeFileSync(ENV_FILE, nextLines.join("\n"), "utf8");
}

function getMaskedSecret(secret) {
  if (!secret) return "";
  if (secret.length <= 6) return "*".repeat(secret.length);
  return `••••••••${secret.slice(-4)}`;
}

function isLoopbackIp(addr) {
  if (!addr) return false;
  return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}

function isCloudRuntime() {
  return Boolean(
    process.env.RENDER ||
      process.env.RAILWAY_ENVIRONMENT ||
      process.env.RAILWAY_PROJECT_ID ||
      process.env.FLY_APP_NAME ||
      process.env.K_SERVICE ||
      process.env.DYNO
  );
}

function isSharedContext(req, cfg) {
  if (
    process.argv.includes("--share") ||
    cfg.APP_MODE === "shared" ||
    isCloudRuntime()
  ) {
    return true;
  }

  for (const hdr of ["x-forwarded-for", "cf-connecting-ip", "forwarded", "x-real-ip"]) {
    if (req.headers[hdr]) return true;
  }

  if (!isLoopbackIp(req.socket?.remoteAddress)) {
    return true;
  }

  const host = String(req.headers.host || "").trim().toLowerCase();
  if (host && !/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host)) {
    return true;
  }

  return false;
}

function resolveEffectiveApiKey(req, isShared, cfg) {
  const headerKey = String(req.headers["x-roblox-api-key"] || "").trim();
  if (headerKey) return headerKey;
  if (isShared) return "";
  return String(cfg.ROBLOX_API_KEY || "").trim();
}

function parseMetaHeader(req) {
  const b64 = req.headers["x-harles-meta"];
  if (!b64 || typeof b64 !== "string") return null;
  try {
    const json = Buffer.from(b64, "base64").toString("utf8");
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function readBodyBuffer(req, maxBytes = MAX_REQUEST_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let settled = false;

    req.on("data", (chunk) => {
      if (settled) return;
      total += chunk.length;
      if (total > maxBytes) {
        settled = true;
        const err = new Error("Payload melebihi batas maksimal 20 MB.");
        err.statusCode = 413;
        req.resume();
        reject(err);
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      if (!settled) {
        settled = true;
        resolve(Buffer.concat(chunks));
      }
    });

    req.on("error", (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
  });
}

function sendJson(res, statusCode, payload) {
  if (res.writableEnded || res.destroyed) return;
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": body.length
  });
  res.end(body);
}

function sendBytes(res, statusCode, bytes, contentType, headOnly = false) {
  if (res.writableEnded || res.destroyed) return;
  res.writeHead(statusCode, {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
    "Content-Length": bytes.length
  });
  res.end(headOnly ? undefined : bytes);
}

async function serveStatic(res, pathname, headOnly = false) {
  let rel = pathname.replace(/^\/+/, "");
  if (!rel) rel = "index.html";

  const baseDir = path.resolve(PUBLIC_DIR);
  const target = path.resolve(baseDir, rel);
  if (target !== baseDir && !target.startsWith(baseDir + path.sep)) {
    sendJson(res, 403, { ok: false, error: "Forbidden" });
    return;
  }

  try {
    const stat = await fsp.stat(target);
    if (!stat.isFile()) {
      sendJson(res, 404, { ok: false, error: "Not found" });
      return;
    }
    const bytes = await fsp.readFile(target);
    const ext = path.extname(target).toLowerCase();
    sendBytes(res, 200, bytes, MIME_TYPES[ext] || "application/octet-stream", headOnly);
  } catch {
    sendJson(res, 404, { ok: false, error: "Not found" });
  }
}

let cachedFfmpegPath;
function resolveFfmpegPath() {
  if (cachedFfmpegPath !== undefined) return cachedFfmpegPath;

  const localExe = path.join(ROOT_DIR, "bin", process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");
  if (fs.existsSync(localExe)) {
    cachedFfmpegPath = localExe;
    return cachedFfmpegPath;
  }

  const pathDirs = String(process.env.PATH || "").split(path.delimiter).filter(Boolean);
  const binName = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
  for (const dir of pathDirs) {
    const candidate = path.join(dir, binName);
    if (fs.existsSync(candidate)) {
      cachedFfmpegPath = candidate;
      return cachedFfmpegPath;
    }
  }

  cachedFfmpegPath = null;
  return null;
}

async function runFfmpegTransform(ffmpegBin, inputBytes, inputExt, speed, preservePitch, outputFormat) {
  const id = crypto.randomUUID();
  const safeExt = String(inputExt || "wav").replace(/[^a-zA-Z0-9]/g, "").toLowerCase() || "wav";
  const outExt = outputFormat === "mp3" ? "mp3" : "ogg";
  const inFile = path.join(os.tmpdir(), `harles_${id}.${safeExt}`);
  const outFile = path.join(os.tmpdir(), `harles_${id}_out.${outExt}`);

  try {
    await fsp.writeFile(inFile, inputBytes);

    let filterExpr;
    if (preservePitch) {
      let rem = speed;
      const parts = [];
      while (rem > 2.0) {
        parts.push("atempo=2.0");
        rem /= 2.0;
      }
      while (rem < 0.5) {
        parts.push("atempo=0.5");
        rem /= 0.5;
      }
      parts.push(`atempo=${rem.toFixed(4)}`);
      filterExpr = parts.join(",");
    } else {
      filterExpr = `asetrate=44100*${speed.toFixed(4)},aresample=44100`;
    }

    const codecArgs =
      outExt === "mp3"
        ? ["-c:a", "libmp3lame", "-b:a", "192k", "-ar", "44100"]
        : ["-c:a", "libvorbis", "-q:a", "5", "-ar", "44100"];

    const args = ["-y", "-hide_banner", "-loglevel", "error", "-i", inFile, "-vn", "-filter:a", filterExpr, ...codecArgs, outFile];

    await new Promise((resolve, reject) => {
      const child = spawn(ffmpegBin, args, { stdio: ["ignore", "ignore", "pipe"] });
      let stderr = "";
      child.stderr.on("data", (d) => {
        stderr += d.toString("utf8");
      });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`FFmpeg gagal: ${stderr || `exit ${code}`}`));
      });
    });

    return await fsp.readFile(outFile);
  } finally {
    await fsp.rm(inFile, { force: true }).catch(() => {});
    await fsp.rm(outFile, { force: true }).catch(() => {});
  }
}

async function handleRobloxUpload(req, res, isShared, cfg) {
  const apiKey = resolveEffectiveApiKey(req, isShared, cfg);
  if (!apiKey) {
    sendJson(res, 400, {
      ok: false,
      error: isShared
        ? "Masukkan Roblox Open Cloud API Key milikmu di form Roblox Target (hanya tersimpan di browser kamu)."
        : "ROBLOX_API_KEY belum diisi. Simpan API Key di panel Roblox Target atau file .env lokal."
    });
    return;
  }

  const meta = parseMetaHeader(req);
  if (!meta) {
    sendJson(res, 400, { ok: false, error: "Header metadata X-Harles-Meta tidak valid." });
    return;
  }

  const creatorType = meta.creatorType === "group" ? "group" : "user";
  let creatorId = String(meta.creatorId || "").trim();
  if (!isShared && !creatorId) {
    creatorId = creatorType === "group" ? String(cfg.ROBLOX_GROUP_ID || "") : String(cfg.ROBLOX_USER_ID || "");
  }
  if (!/^\d+$/.test(creatorId)) {
    sendJson(res, 400, {
      ok: false,
      error: `Target ${creatorType.toUpperCase()} ID wajib berupa angka yang valid.`
    });
    return;
  }

  let displayName = String(meta.displayName || "").trim() || "Harles Studio Audio";
  if (displayName.length > 50) displayName = displayName.slice(0, 50).trim();
  const description = String(meta.description || "Uploaded via Harles Studio");
  const mimeType = String(meta.mimeType || "audio/wav");

  if (!ALLOWED_AUDIO_MIMES.has(mimeType)) {
    sendJson(res, 400, {
      ok: false,
      error: `Format MIME tidak didukung Roblox (${mimeType}). Gunakan WAV, OGG, MP3, atau FLAC.`
    });
    return;
  }

  const audioBytes = await readBodyBuffer(req, MAX_AUDIO_BYTES);
  if (audioBytes.length === 0) {
    sendJson(res, 400, { ok: false, error: "File audio kosong." });
    return;
  }

  const safeName = String(meta.fileName || "audio.wav").replace(/[^a-zA-Z0-9._-]/g, "_") || "audio.wav";
  const metadata = {
    assetType: "Audio",
    displayName,
    description,
    creationContext: {
      creator: creatorType === "group" ? { groupId: creatorId } : { userId: creatorId }
    }
  };

  const form = new FormData();
  form.append("request", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
  form.append("fileContent", new Blob([audioBytes], { type: mimeType }), safeName);

  const resp = await fetch("https://apis.roblox.com/assets/v1/assets", {
    method: "POST",
    headers: { "x-api-key": apiKey },
    body: form
  });

  const respText = await resp.text();
  let respJson = null;
  try {
    respJson = JSON.parse(respText);
  } catch {}

  if (!resp.ok) {
    const errMsg = respJson?.message || respText || `HTTP ${resp.status}`;
    sendJson(res, resp.status, {
      ok: false,
      error: `Roblox API menolak upload (HTTP ${resp.status}): ${errMsg}`
    });
    return;
  }

  if (respJson?.done === true) {
    if (respJson.error) {
      sendJson(res, 400, {
        ok: false,
        error: `Operasi Roblox gagal: ${respJson.error.message || "Unknown error"}`
      });
      return;
    }
    sendJson(res, 200, {
      ok: true,
      done: true,
      assetId: String(respJson.response?.assetId || ""),
      displayName,
      operationPath: String(respJson.path || "")
    });
    return;
  }

  const opPath = String(respJson?.path || "");
  if (!opPath) {
    sendJson(res, 502, { ok: false, error: "Respons Roblox tidak menyertakan operation path." });
    return;
  }

  sendJson(res, 200, {
    ok: true,
    done: false,
    displayName,
    operationPath: opPath
  });
}

async function handleRobloxOperation(req, res, urlObj, isShared, cfg) {
  const apiKey = resolveEffectiveApiKey(req, isShared, cfg);
  if (!apiKey) {
    sendJson(res, 400, { ok: false, error: "API Key tidak tersedia untuk mengecek operasi Roblox." });
    return;
  }

  const opPath = String(urlObj.searchParams.get("path") || "").trim();
  if (!/^operations\/[a-zA-Z0-9_-]+$/.test(opPath)) {
    sendJson(res, 400, { ok: false, error: "Operation path tidak valid." });
    return;
  }

  const resp = await fetch(`https://apis.roblox.com/assets/v1/${opPath}`, {
    method: "GET",
    headers: { "x-api-key": apiKey }
  });

  const bodyText = await resp.text();
  let data = null;
  try {
    data = JSON.parse(bodyText);
  } catch {}

  if (!resp.ok) {
    const errMsg = data?.message || bodyText || `HTTP ${resp.status}`;
    sendJson(res, resp.status, {
      ok: false,
      error: `Gagal mengecek status operasi Roblox (HTTP ${resp.status}): ${errMsg}`
    });
    return;
  }

  if (data?.done === true) {
    if (data.error) {
      sendJson(res, 400, {
        ok: false,
        done: true,
        error: `Moderasi/proses Roblox gagal: ${data.error.message || "Unknown error"}`
      });
      return;
    }
    sendJson(res, 200, {
      ok: true,
      done: true,
      assetId: String(data.response?.assetId || ""),
      operationPath: opPath
    });
    return;
  }

  sendJson(res, 200, { ok: true, done: false, operationPath: opPath });
}

const server = http.createServer(async (req, res) => {
  const urlObj = new URL(req.url || "/", "http://127.0.0.1");
  const pathname = urlObj.pathname;
  const cfg = readDotEnv();
  const isShared = isSharedContext(req, cfg);
  const ffmpegBin = resolveFfmpegPath();

  try {
    if (req.method === "GET" && pathname === "/api/health") {
      sendJson(res, 200, {
        ok: true,
        service: "harles-studio",
        mode: isShared ? "shared" : "personal",
        ffmpeg: Boolean(ffmpegBin)
      });
      return;
    }

    if (req.method === "GET" && pathname === "/api/config") {
      if (isShared) {
        sendJson(res, 200, {
          ok: true,
          mode: "shared",
          hasApiKey: false,
          maskedKey: "",
          defaultTarget: "user",
          userId: "",
          groupId: "",
          ffmpegAvailable: Boolean(ffmpegBin)
        });
      } else {
        const apiKey = cfg.ROBLOX_API_KEY || "";
        sendJson(res, 200, {
          ok: true,
          mode: "personal",
          hasApiKey: Boolean(apiKey.trim()),
          maskedKey: getMaskedSecret(apiKey.trim()),
          defaultTarget: cfg.ROBLOX_DEFAULT_TARGET === "group" ? "group" : "user",
          userId: String(cfg.ROBLOX_USER_ID || ""),
          groupId: String(cfg.ROBLOX_GROUP_ID || ""),
          ffmpegAvailable: Boolean(ffmpegBin)
        });
      }
      return;
    }

    if (req.method === "POST" && pathname === "/api/config") {
      if (isShared) {
        sendJson(res, 403, {
          ok: false,
          error: "Mode Berbagi aktif: .env server dikunci. Masukkan API Key di browser kamu untuk sesi ini."
        });
        return;
      }

      const raw = await readBodyBuffer(req, 64 * 1024);
      const data = JSON.parse(raw.toString("utf8") || "{}");
      const updates = {};

      if (data.defaultTarget !== undefined) {
        updates.ROBLOX_DEFAULT_TARGET = data.defaultTarget === "group" ? "group" : "user";
      }
      if (data.userId !== undefined) {
        updates.ROBLOX_USER_ID = String(data.userId || "").trim();
      }
      if (data.groupId !== undefined) {
        updates.ROBLOX_GROUP_ID = String(data.groupId || "").trim();
      }
      if (typeof data.apiKey === "string" && data.apiKey.trim()) {
        updates.ROBLOX_API_KEY = data.apiKey.trim();
      } else if (data.clearApiKey === true) {
        updates.ROBLOX_API_KEY = "";
      }

      saveDotEnv(updates);
      const nextCfg = readDotEnv();
      const apiKey = nextCfg.ROBLOX_API_KEY || "";
      sendJson(res, 200, {
        ok: true,
        mode: "personal",
        hasApiKey: Boolean(apiKey.trim()),
        maskedKey: getMaskedSecret(apiKey.trim()),
        defaultTarget: nextCfg.ROBLOX_DEFAULT_TARGET === "group" ? "group" : "user",
        userId: String(nextCfg.ROBLOX_USER_ID || ""),
        groupId: String(nextCfg.ROBLOX_GROUP_ID || ""),
        ffmpegAvailable: Boolean(ffmpegBin)
      });
      return;
    }

    if (req.method === "POST" && pathname === "/api/audio/ffmpeg") {
      if (!ffmpegBin) {
        sendJson(res, 400, { ok: false, error: "FFmpeg tidak ditemukan di server." });
        return;
      }
      const meta = parseMetaHeader(req);
      if (!meta) {
        sendJson(res, 400, { ok: false, error: "Metadata header X-Harles-Meta tidak valid." });
        return;
      }
      const inputBytes = await readBodyBuffer(req, MAX_AUDIO_BYTES);
      let speed = Number(meta.speed) || 1.0;
      if (speed < 0.25 || speed > 4.0) speed = 1.0;
      const preservePitch = Boolean(meta.preservePitch);
      const outFormat = meta.outputFormat === "mp3" ? "mp3" : "ogg";
      const outBytes = await runFfmpegTransform(ffmpegBin, inputBytes, meta.inputExt, speed, preservePitch, outFormat);
      sendBytes(res, 200, outBytes, outFormat === "mp3" ? "audio/mpeg" : "audio/ogg");
      return;
    }

    if (req.method === "POST" && pathname === "/api/roblox/upload") {
      await handleRobloxUpload(req, res, isShared, cfg);
      return;
    }

    if (req.method === "GET" && pathname === "/api/roblox/operation") {
      await handleRobloxOperation(req, res, urlObj, isShared, cfg);
      return;
    }

    if (req.method === "GET" || req.method === "HEAD") {
      await serveStatic(res, pathname, req.method === "HEAD");
      return;
    }

    sendJson(res, 405, { ok: false, error: "Method Not Allowed" });
  } catch (err) {
    const code = Number(err?.statusCode) || 500;
    sendJson(res, code, { ok: false, error: err?.message || "Internal server error" });
  }
});

const bootCfg = readDotEnv();
const port = Number(process.env.PORT || bootCfg.PORT || 3456);
const host = process.env.HOST || (isCloudRuntime() || process.env.PORT || process.argv.includes("--share") ? "0.0.0.0" : "127.0.0.1");

server.listen(port, host, () => {
  console.log(`Harles Studio listening on http://${host}:${port} (cloud=${isCloudRuntime()})`);
});
