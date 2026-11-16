const MAX_AUDIO_BYTES = 20 * 1024 * 1024;
const ALLOWED_AUDIO_MIMES = new Set(["audio/wav", "audio/ogg", "audio/mpeg", "audio/flac"]);

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}

function parseMetaHeader(request) {
  const b64 = request.headers.get("X-Harles-Meta");
  if (!b64) return null;
  try {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) {
      bytes[i] = bin.charCodeAt(i);
    }
    const text = new TextDecoder().decode(bytes);
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function handleRobloxUpload(request) {
  const apiKey = (request.headers.get("X-Roblox-Api-Key") || "").trim();
  if (!apiKey) {
    return jsonResponse(
      {
        ok: false,
        error: "Masukkan Roblox Open Cloud API Key milikmu di form Roblox Target (hanya tersimpan di browser kamu)."
      },
      400
    );
  }

  const meta = parseMetaHeader(request);
  if (!meta) {
    return jsonResponse({ ok: false, error: "Header metadata X-Harles-Meta tidak valid." }, 400);
  }

  const creatorType = meta.creatorType === "group" ? "group" : "user";
  const creatorId = String(meta.creatorId || "").trim();
  if (!/^\d+$/.test(creatorId)) {
    return jsonResponse(
      { ok: false, error: `Target ${creatorType.toUpperCase()} ID wajib berupa angka yang valid.` },
      400
    );
  }

  let displayName = String(meta.displayName || "").trim() || "Harles Studio Audio";
  if (displayName.length > 50) displayName = displayName.slice(0, 50).trim();
  const description = String(meta.description || "Uploaded via Harles Studio");
  const mimeType = String(meta.mimeType || "audio/wav");

  if (!ALLOWED_AUDIO_MIMES.has(mimeType)) {
    return jsonResponse(
      {
        ok: false,
        error: `Format MIME tidak didukung Roblox (${mimeType}). Gunakan WAV, OGG, MP3, atau FLAC.`
      },
      400
    );
  }

  const declaredLen = Number(request.headers.get("content-length") || 0);
  if (declaredLen > MAX_AUDIO_BYTES) {
    return jsonResponse({ ok: false, error: "Ukuran file melebihi batas maksimal 20 MB dari Roblox." }, 413);
  }

  const audioBytes = await request.arrayBuffer();
  if (audioBytes.byteLength === 0) {
    return jsonResponse({ ok: false, error: "File audio kosong." }, 400);
  }
  if (audioBytes.byteLength > MAX_AUDIO_BYTES) {
    return jsonResponse({ ok: false, error: "Ukuran file melebihi batas maksimal 20 MB dari Roblox." }, 413);
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
    return jsonResponse({ ok: false, error: `Roblox API menolak upload (HTTP ${resp.status}): ${errMsg}` }, resp.status);
  }

  if (respJson?.done === true) {
    if (respJson.error) {
      return jsonResponse(
        { ok: false, error: `Operasi Roblox gagal: ${respJson.error.message || "Unknown error"}` },
        400
      );
    }
    return jsonResponse({
      ok: true,
      done: true,
      assetId: String(respJson.response?.assetId || ""),
      displayName,
      operationPath: String(respJson.path || "")
    });
  }

  const opPath = String(respJson?.path || "");
  if (!opPath) {
    return jsonResponse({ ok: false, error: "Respons Roblox tidak menyertakan operation path." }, 502);
  }

  return jsonResponse({
    ok: true,
    done: false,
    displayName,
    operationPath: opPath
  });
}

async function handleRobloxOperation(request, url) {
  const apiKey = (request.headers.get("X-Roblox-Api-Key") || "").trim();
  if (!apiKey) {
    return jsonResponse({ ok: false, error: "API Key tidak tersedia untuk mengecek operasi Roblox." }, 400);
  }

  const opPath = (url.searchParams.get("path") || "").trim();
  if (!/^operations\/[a-zA-Z0-9_-]+$/.test(opPath)) {
    return jsonResponse({ ok: false, error: "Operation path tidak valid." }, 400);
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
    return jsonResponse(
      { ok: false, error: `Gagal mengecek status operasi Roblox (HTTP ${resp.status}): ${errMsg}` },
      resp.status
    );
  }

  if (data?.done === true) {
    if (data.error) {
      return jsonResponse(
        {
          ok: false,
          done: true,
          error: `Moderasi/proses Roblox gagal: ${data.error.message || "Unknown error"}`
        },
        400
      );
    }
    return jsonResponse({
      ok: true,
      done: true,
      assetId: String(data.response?.assetId || ""),
      operationPath: opPath
    });
  }

  return jsonResponse({ ok: true, done: false, operationPath: opPath });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;

    try {
      if (request.method === "GET" && pathname === "/api/health") {
        return jsonResponse({
          ok: true,
          service: "harles-studio",
          mode: "shared",
          ffmpeg: false
        });
      }

      if (request.method === "GET" && pathname === "/api/config") {
        return jsonResponse({
          ok: true,
          mode: "shared",
          hasApiKey: false,
          maskedKey: "",
          defaultTarget: "user",
          userId: "",
          groupId: "",
          ffmpegAvailable: false
        });
      }

      if (request.method === "POST" && pathname === "/api/config") {
        return jsonResponse(
          {
            ok: false,
            error: "Mode Berbagi aktif: masukkan API Key langsung di browser kamu untuk sesi ini."
          },
          403
        );
      }

      if (request.method === "POST" && pathname === "/api/roblox/upload") {
        return await handleRobloxUpload(request);
      }

      if (request.method === "GET" && pathname === "/api/roblox/operation") {
        return await handleRobloxOperation(request, url);
      }

      if (pathname.startsWith("/api/")) {
        return jsonResponse({ ok: false, error: "Endpoint tidak ditemukan." }, 404);
      }

      return env.ASSETS.fetch(request);
    } catch (err) {
      return jsonResponse({ ok: false, error: err?.message || "Internal server error" }, 500);
    }
  }
};
