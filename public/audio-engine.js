(function (global) {
  "use strict";

  const ROBLOX_MAX_BYTES = 20 * 1024 * 1024;
  const ROBLOX_SAFE_WAV_BYTES = 19.2 * 1024 * 1024;
  const ROBLOX_MAX_DURATION_SEC = 7 * 60;
  const ROBLOX_DIRECT_MIME_BY_EXT = {
    mp3: "audio/mpeg",
    ogg: "audio/ogg",
    wav: "audio/wav",
    flac: "audio/flac"
  };

  let sharedAudioCtx = null;

  function getAudioContext() {
    if (!sharedAudioCtx) {
      const Ctx = global.AudioContext || global.webkitAudioContext;
      sharedAudioCtx = new Ctx();
    }
    return sharedAudioCtx;
  }

  function encodeBase64Utf8(text) {
    const bytes = new TextEncoder().encode(text);
    let bin = "";
    for (let i = 0; i < bytes.length; i++) {
      bin += String.fromCharCode(bytes[i]);
    }
    return btoa(bin);
  }

  function sanitizeDisplayName(filename) {
    const withoutExt = String(filename || "Harles Audio").replace(/\.[^/.]+$/, "");
    const cleaned = withoutExt
      .replace(/[^\p{L}\p{N}\s._-]/gu, " ")
      .replace(/\s+/g, " ")
      .trim();
    const result = cleaned || "Harles Studio Audio";
    return result.slice(0, 50).trim();
  }

  function getExtension(filename) {
    const m = String(filename || "").toLowerCase().match(/\.([a-z0-9]+)$/);
    return m ? m[1] : "";
  }

  function formatTime(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
    const total = Math.floor(seconds);
    const mins = Math.floor(total / 60);
    const secs = total % 60;
    return `${mins}:${secs.toString().padStart(2, "0")}`;
  }

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  }

  function extractWaveformPeaks(audioBuffer, barCount) {
    const count = barCount || 96;
    const ch0 = audioBuffer.getChannelData(0);
    const ch1 = audioBuffer.numberOfChannels > 1 ? audioBuffer.getChannelData(1) : null;
    const blockSize = Math.max(1, Math.floor(ch0.length / count));
    const peaks = new Float32Array(count);
    let globalMax = 0.001;

    for (let i = 0; i < count; i++) {
      const start = i * blockSize;
      const end = Math.min(ch0.length, start + blockSize);
      let max = 0;
      const step = Math.max(1, Math.floor((end - start) / 48));
      for (let j = start; j < end; j += step) {
        const val = ch1 ? (Math.abs(ch0[j]) + Math.abs(ch1[j])) * 0.5 : Math.abs(ch0[j]);
        if (val > max) max = val;
      }
      peaks[i] = max;
      if (max > globalMax) globalMax = max;
    }

    for (let i = 0; i < count; i++) {
      peaks[i] = Math.max(0.08, peaks[i] / globalMax);
    }
    return peaks;
  }

  async function decodeAudioFile(file) {
    const ctx = getAudioContext();
    const buffer = await file.arrayBuffer();
    const audioBuffer = await ctx.decodeAudioData(buffer.slice(0));
    const peaks = extractWaveformPeaks(audioBuffer, 96);
    return {
      audioBuffer,
      duration: audioBuffer.duration,
      sampleRate: audioBuffer.sampleRate,
      channels: audioBuffer.numberOfChannels,
      peaks
    };
  }

  function estimateWavPlan(durationAfterSpeed, sourceChannels, sourceSampleRate) {
    const srcRate = Math.min(sourceSampleRate || 44100, 48000);
    const srcCh = Math.min(sourceChannels || 2, 2);
    const candidates = [
      { sampleRate: srcRate, channels: srcCh, label: `${(srcRate / 1000).toFixed(1)} kHz ${srcCh === 2 ? "Stereo" : "Mono"}` },
      { sampleRate: 44100, channels: 1, label: "44.1 kHz Mono" },
      { sampleRate: 24000, channels: 1, label: "24 kHz Mono" },
      { sampleRate: 16000, channels: 1, label: "16 kHz Mono" }
    ];

    for (const c of candidates) {
      const bytes = 44 + Math.ceil(durationAfterSpeed * c.sampleRate) * c.channels * 2;
      if (bytes <= ROBLOX_SAFE_WAV_BYTES) {
        return { ...c, estimatedBytes: bytes, exceedsMaxBytes: false };
      }
    }

    const fallback = candidates[candidates.length - 1];
    const fallbackBytes = 44 + Math.ceil(durationAfterSpeed * fallback.sampleRate) * fallback.channels * 2;
    return {
      ...fallback,
      estimatedBytes: fallbackBytes,
      exceedsMaxBytes: fallbackBytes > ROBLOX_MAX_BYTES
    };
  }

  function resampleLinear(input, outLength) {
    const output = new Float32Array(outLength);
    if (input.length === 0 || outLength === 0) return output;
    if (input.length === 1) {
      output.fill(input[0]);
      return output;
    }
    const ratio = (input.length - 1) / Math.max(1, outLength - 1);
    for (let i = 0; i < outLength; i++) {
      const pos = i * ratio;
      const idx = Math.floor(pos);
      const frac = pos - idx;
      const s0 = input[idx];
      const s1 = idx + 1 < input.length ? input[idx + 1] : s0;
      output[i] = s0 + (s1 - s0) * frac;
    }
    return output;
  }

  function timeStretchWsola(channelArrays, speed, sampleRate) {
    const numCh = channelArrays.length;
    const inLen = channelArrays[0].length;
    if (Math.abs(speed - 1.0) < 0.001 || inLen < 4096) {
      return channelArrays.map((arr) => {
        const outLen = Math.max(1, Math.round(arr.length / speed));
        return Math.abs(speed - 1.0) < 0.001 ? new Float32Array(arr) : resampleLinear(arr, outLen);
      });
    }

    const winSize = sampleRate <= 24000 ? 1024 : 2048;
    const synHop = winSize >> 1;
    const searchRadius = Math.min(192, synHop >> 1);
    const outLen = Math.max(1, Math.round(inLen / speed));

    const hann = new Float32Array(winSize);
    for (let i = 0; i < winSize; i++) {
      hann[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / winSize));
    }

    const mono = new Float32Array(inLen);
    if (numCh === 1) {
      mono.set(channelArrays[0]);
    } else {
      for (let i = 0; i < inLen; i++) {
        let sum = 0;
        for (let c = 0; c < numCh; c++) sum += channelArrays[c][i];
        mono[i] = sum / numCh;
      }
    }

    const outMono = new Float32Array(outLen);
    const winWeight = new Float32Array(outLen);
    const outChannels = [];
    for (let c = 0; c < numCh; c++) {
      outChannels.push(new Float32Array(outLen));
    }

    let outPos = 0;
    let anaPos = 0;

    while (outPos < outLen) {
      const nominal = Math.min(Math.max(0, Math.round(anaPos)), Math.max(0, inLen - 1));
      let bestPos = nominal;

      if (outPos > 0 && inLen > winSize) {
        const minCand = Math.max(0, nominal - searchRadius);
        const maxCand = Math.min(inLen - synHop, nominal + searchRadius);
        let bestScore = -Infinity;

        for (let cand = minCand; cand <= maxCand; cand += 2) {
          let dot = 0;
          let energy = 1e-9;
          for (let k = 0; k < synHop; k += 4) {
            const outVal = outMono[outPos + k];
            const inVal = mono[cand + k];
            dot += outVal * inVal;
            energy += inVal * inVal;
          }
          const score = dot / Math.sqrt(energy);
          if (score > bestScore) {
            bestScore = score;
            bestPos = cand;
          }
        }
      }

      const copyLen = Math.min(winSize, outLen - outPos);
      for (let i = 0; i < copyLen; i++) {
        const srcIdx = bestPos + i;
        const w = hann[i];
        const mVal = srcIdx < inLen ? mono[srcIdx] : 0;
        outMono[outPos + i] += mVal * w;
        winWeight[outPos + i] += w;
        for (let c = 0; c < numCh; c++) {
          const s = srcIdx < inLen ? channelArrays[c][srcIdx] : 0;
          outChannels[c][outPos + i] += s * w;
        }
      }

      outPos += synHop;
      anaPos += synHop * speed;
    }

    for (let c = 0; c < numCh; c++) {
      const ch = outChannels[c];
      for (let i = 0; i < outLen; i++) {
        const w = winWeight[i];
        const val = w > 0.1 ? ch[i] / w : ch[i];
        ch[i] = val > 1 ? 1 : val < -1 ? -1 : val;
      }
    }

    return outChannels;
  }

  function encodeWav16Bit(channelArrays, sampleRate) {
    const numChannels = channelArrays.length;
    const numSamples = channelArrays[0].length;
    const dataBytes = numSamples * numChannels * 2;
    const buffer = new ArrayBuffer(44 + dataBytes);
    const view = new DataView(buffer);

    function writeAscii(offset, text) {
      for (let i = 0; i < text.length; i++) {
        view.setUint8(offset + i, text.charCodeAt(i));
      }
    }

    writeAscii(0, "RIFF");
    view.setUint32(4, 36 + dataBytes, true);
    writeAscii(8, "WAVE");
    writeAscii(12, "fmt ");
    view.setUint32(16, 16, true); // PCM chunk size
    view.setUint16(20, 1, true);  // PCM format
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * numChannels * 2, true);
    view.setUint16(32, numChannels * 2, true);
    view.setUint16(34, 16, true);
    writeAscii(36, "data");
    view.setUint32(40, dataBytes, true);

    let offset = 44;
    for (let i = 0; i < numSamples; i++) {
      for (let c = 0; c < numChannels; c++) {
        const sample = Math.max(-1, Math.min(1, channelArrays[c][i]));
        view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
        offset += 2;
      }
    }

    return new Blob([buffer], { type: "audio/wav" });
  }

  function buildChannelInputs(audioBuffer, targetChannels) {
    const srcCount = audioBuffer.numberOfChannels;
    if (targetChannels === 1 && srcCount > 1) {
      const mono = new Float32Array(audioBuffer.length);
      const c0 = audioBuffer.getChannelData(0);
      const c1 = audioBuffer.getChannelData(1);
      for (let i = 0; i < mono.length; i++) {
        mono[i] = (c0[i] + c1[i]) * 0.5;
      }
      return [mono];
    }
    const list = [];
    for (let c = 0; c < targetChannels; c++) {
      list.push(new Float32Array(audioBuffer.getChannelData(Math.min(c, srcCount - 1))));
    }
    return list;
  }

  async function renderTrackToBlob(track, options) {
    const speed = Number(track.speed) || 1.0;
    const preservePitch = Boolean(track.preservePitch);
    const formatMode = (options && options.formatMode) || "auto";
    const ffmpegAvailable = Boolean(options && options.ffmpegAvailable);
    const ext = getExtension(track.file.name);
    const baseName = sanitizeDisplayName(track.displayName || track.file.name).replace(/\s+/g, "_");

    // 1. Lossless bypass when speed is 1.0x and format is already Roblox-supported <= 20 MB
    if (
      formatMode === "auto" &&
      Math.abs(speed - 1.0) < 0.001 &&
      ROBLOX_DIRECT_MIME_BY_EXT[ext] &&
      track.file.size <= ROBLOX_MAX_BYTES
    ) {
      return {
        blob: track.file,
        mimeType: ROBLOX_DIRECT_MIME_BY_EXT[ext],
        ext,
        fileName: `${baseName}.${ext}`,
        modeLabel: `Original (${ext.toUpperCase()})`
      };
    }

    // 2. Optional server FFmpeg transcode when user selects OGG or MP3 and FFmpeg is available
    if (ffmpegAvailable && (formatMode === "ogg" || formatMode === "mp3")) {
      const meta = {
        inputExt: ext || "wav",
        speed,
        preservePitch,
        outputFormat: formatMode
      };
      const b64Meta = encodeBase64Utf8(JSON.stringify(meta));
      const resp = await fetch("/api/audio/ffmpeg", {
        method: "POST",
        headers: {
          "Content-Type": "application/octet-stream",
          "X-Harles-Meta": b64Meta
        },
        body: track.file
      });
      if (!resp.ok) {
        const errPayload = await resp.json().catch(() => ({}));
        throw new Error(errPayload.error || `FFmpeg gagal memproses (${resp.status})`);
      }
      const blob = await resp.blob();
      const mimeType = formatMode === "mp3" ? "audio/mpeg" : "audio/ogg";
      return {
        blob,
        mimeType,
        ext: formatMode,
        fileName: `${baseName}_${speed.toFixed(2)}x.${formatMode}`,
        modeLabel: `FFmpeg ${formatMode.toUpperCase()}`
      };
    }

    // 3. Built-in Zero-Install Browser Web Audio DSP -> WAV
    const ab = track.audioBuffer;
    const adjustedDuration = ab.duration / speed;
    const plan = estimateWavPlan(adjustedDuration, ab.numberOfChannels, ab.sampleRate);
    let channels = buildChannelInputs(ab, plan.channels);

    if (preservePitch && Math.abs(speed - 1.0) >= 0.001) {
      channels = timeStretchWsola(channels, speed, ab.sampleRate);
      if (ab.sampleRate !== plan.sampleRate) {
        const targetLen = Math.max(1, Math.round(channels[0].length * (plan.sampleRate / ab.sampleRate)));
        channels = channels.map((ch) => resampleLinear(ch, targetLen));
      }
    } else {
      const targetLen = Math.max(1, Math.round((ab.length / speed) * (plan.sampleRate / ab.sampleRate)));
      channels = channels.map((ch) => resampleLinear(ch, targetLen));
    }

    const blob = encodeWav16Bit(channels, plan.sampleRate);
    return {
      blob,
      mimeType: "audio/wav",
      ext: "wav",
      fileName: `${baseName}_${speed.toFixed(2)}x.wav`,
      modeLabel: `WAV ${plan.label}`
    };
  }

  global.HarlesAudio = {
    ROBLOX_MAX_BYTES,
    ROBLOX_MAX_DURATION_SEC,
    encodeBase64Utf8,
    sanitizeDisplayName,
    getExtension,
    formatTime,
    formatBytes,
    decodeAudioFile,
    estimateWavPlan,
    renderTrackToBlob
  };
})(window);
