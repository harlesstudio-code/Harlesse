(function () {
  "use strict";

  const AudioEngine = window.HarlesAudio;

  const state = {
    tracks: [],
    selectedTrackId: null,
    playingTrackId: null,
    masterSpeed: 1.0,
    masterPreservePitch: true,
    formatMode: "auto",
    ffmpegAvailable: false,
    config: {
      mode: "personal",
      hasApiKey: false,
      maskedKey: "",
      defaultTarget: "user",
      userId: "",
      groupId: ""
    },
    sessionApiKey: "",
    busy: false
  };

  const els = {
    navPills: Array.from(document.querySelectorAll(".nav-pill")),
    heroEngineBadge: document.getElementById("heroEngineBadge"),
    dropZone: document.getElementById("dropZone"),
    audioFileInput: document.getElementById("audioFileInput"),
    btnPickFiles: document.getElementById("btnPickFiles"),
    btnClearAll: document.getElementById("btnClearAll"),
    queueCountPill: document.getElementById("queueCountPill"),
    masterSpeedSlider: document.getElementById("masterSpeedSlider"),
    masterSpeedReadout: document.getElementById("masterSpeedReadout"),
    masterPreservePitch: document.getElementById("masterPreservePitch"),
    presetPills: Array.from(document.querySelectorAll(".preset-pill")),
    exportFormatSelect: document.getElementById("exportFormatSelect"),
    btnApplyMasterAll: document.getElementById("btnApplyMasterAll"),
    previewSpeedBadge: document.getElementById("previewSpeedBadge"),
    previewTrackTitle: document.getElementById("previewTrackTitle"),
    waveformCanvas: document.getElementById("waveformCanvas"),
    previewSeekBar: document.getElementById("previewSeekBar"),
    previewCurrentTime: document.getElementById("previewCurrentTime"),
    previewAdjustedDuration: document.getElementById("previewAdjustedDuration"),
    btnPreviewPlay: document.getElementById("btnPreviewPlay"),
    btnPreviewStop: document.getElementById("btnPreviewStop"),
    iconPlay: document.getElementById("iconPlay"),
    iconPause: document.getElementById("iconPause"),
    previewVolume: document.getElementById("previewVolume"),
    queueEmptyState: document.getElementById("queueEmptyState"),
    queueList: document.getElementById("queueList"),
    btnDownloadAll: document.getElementById("btnDownloadAll"),
    btnUploadAll: document.getElementById("btnUploadAll"),
    batchProgressBarWrap: document.getElementById("batchProgressBarWrap"),
    batchProgressLabel: document.getElementById("batchProgressLabel"),
    batchProgressCount: document.getElementById("batchProgressCount"),
    batchProgressFill: document.getElementById("batchProgressFill"),
    shareModeBanner: document.getElementById("shareModeBanner"),
    tabTargetUser: document.getElementById("tabTargetUser"),
    tabTargetGroup: document.getElementById("tabTargetGroup"),
    robloxConfigForm: document.getElementById("robloxConfigForm"),
    inputUserId: document.getElementById("inputUserId"),
    inputGroupId: document.getElementById("inputGroupId"),
    inputApiKey: document.getElementById("inputApiKey"),
    btnSaveRobloxConfig: document.getElementById("btnSaveRobloxConfig"),
    apiKeyStatusBadge: document.getElementById("apiKeyStatusBadge"),
    apiKeyHelpNote: document.getElementById("apiKeyHelpNote"),
    footerFfmpegStatus: document.getElementById("footerFfmpegStatus"),
    toastContainer: document.getElementById("toastContainer")
  };

  // Single HTML5 audio element for live instant playbackRate + preservesPitch preview
  const player = new Audio();
  player.preload = "auto";
  player.volume = Number(els.previewVolume.value || 0.9);
  let activeObjectUrl = null;
  let rafId = null;

  function showToast(message, type) {
    const div = document.createElement("div");
    div.className = `toast ${type || ""}`;
    div.textContent = message;
    els.toastContainer.appendChild(div);
    setTimeout(() => {
      div.remove();
    }, 4200);
  }

  function applyPitchPreservation(audioEl, preserve) {
    if ("preservesPitch" in audioEl) audioEl.preservesPitch = preserve;
    if ("mozPreservesPitch" in audioEl) audioEl.mozPreservesPitch = preserve;
    if ("webkitPreservesPitch" in audioEl) audioEl.webkitPreservesPitch = preserve;
  }

  function getSelectedTrack() {
    return state.tracks.find((t) => t.id === state.selectedTrackId) || null;
  }

  function drawWaveform(track, progressRatio) {
    const canvas = els.waveformCanvas;
    const ctx = canvas.getContext("2d");
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    if (!track || !track.peaks) {
      ctx.fillStyle = "rgba(255,255,255,0.22)";
      const bars = 48;
      const gap = w / bars;
      for (let i = 0; i < bars; i++) {
        const barH = 12 + Math.sin(i * 0.45) * 8;
        ctx.fillRect(i * gap + 2, (h - barH) / 2, Math.max(2, gap - 4), barH);
      }
      return;
    }

    const peaks = track.peaks;
    const barW = w / peaks.length;
    const ratio = Math.max(0, Math.min(1, progressRatio || 0));

    for (let i = 0; i < peaks.length; i++) {
      const barH = Math.max(6, peaks[i] * (h - 14));
      const x = i * barW + 1;
      const y = (h - barH) / 2;
      const isPlayed = i / peaks.length <= ratio;
      ctx.fillStyle = isPlayed ? "#fd853a" : "rgba(255, 255, 255, 0.28)";
      ctx.beginPath();
      if (ctx.roundRect) {
        ctx.roundRect(x, y, Math.max(2, barW - 2), barH, 3);
      } else {
        ctx.rect(x, y, Math.max(2, barW - 2), barH);
      }
      ctx.fill();
    }
  }

  function syncPreviewDeckUI() {
    const track = getSelectedTrack();
    if (!track) {
      els.previewTrackTitle.textContent = "Belum ada track dipilih";
      els.previewSpeedBadge.textContent = `${state.masterSpeed.toFixed(2)}x · ${state.masterPreservePitch ? "Pitch Tetap" : "Pitch Ikut"}`;
      els.previewCurrentTime.textContent = "0:00";
      els.previewAdjustedDuration.textContent = "0:00";
      els.previewSeekBar.value = 0;
      els.previewSeekBar.disabled = true;
      els.btnPreviewPlay.disabled = true;
      els.btnPreviewStop.disabled = true;
      els.iconPlay.hidden = false;
      els.iconPause.hidden = true;
      drawWaveform(null, 0);
      return;
    }

    const adjDur = track.duration / track.speed;
    const isPlayingThis = state.playingTrackId === track.id && !player.paused;
    const currentRaw = state.playingTrackId === track.id ? player.currentTime : 0;
    const progress = track.duration > 0 ? currentRaw / track.duration : 0;

    els.previewTrackTitle.textContent = track.displayName || track.file.name;
    els.previewSpeedBadge.textContent = `${track.speed.toFixed(2)}x · ${track.preservePitch ? "Pitch Tetap" : "Pitch Ikut"}`;
    els.previewCurrentTime.textContent = AudioEngine.formatTime(currentRaw / track.speed);
    els.previewAdjustedDuration.textContent = AudioEngine.formatTime(adjDur);
    els.previewSeekBar.disabled = false;
    els.previewSeekBar.value = Math.round(progress * 1000);
    els.btnPreviewPlay.disabled = false;
    els.btnPreviewStop.disabled = false;
    els.iconPlay.hidden = isPlayingThis;
    els.iconPause.hidden = !isPlayingThis;
    drawWaveform(track, progress);
  }

  function tickPlaybackUI() {
    if (rafId) cancelAnimationFrame(rafId);
    if (!player.paused && state.playingTrackId) {
      syncPreviewDeckUI();
      rafId = requestAnimationFrame(tickPlaybackUI);
    } else {
      syncPreviewDeckUI();
    }
  }

  function loadAndPlayTrack(track, autoPlay) {
    if (!track) return;
    const isSame = state.playingTrackId === track.id && activeObjectUrl;

    if (!isSame) {
      if (activeObjectUrl) {
        URL.revokeObjectURL(activeObjectUrl);
        activeObjectUrl = null;
      }
      activeObjectUrl = URL.createObjectURL(track.file);
      player.src = activeObjectUrl;
      state.playingTrackId = track.id;
    }

    state.selectedTrackId = track.id;
    player.playbackRate = track.speed;
    applyPitchPreservation(player, track.preservePitch);

    if (autoPlay) {
      player.play().then(() => {
        tickPlaybackUI();
        renderQueue();
      }).catch((err) => {
        showToast(`Gagal memutar preview: ${err.message}`, "error");
      });
    } else {
      syncPreviewDeckUI();
      renderQueue();
    }
  }

  function togglePlayTrack(trackId) {
    const track = state.tracks.find((t) => t.id === trackId);
    if (!track) return;

    if (state.playingTrackId === track.id && !player.paused) {
      player.pause();
      syncPreviewDeckUI();
      renderQueue();
      return;
    }

    loadAndPlayTrack(track, true);
  }

  function stopPreview() {
    player.pause();
    player.currentTime = 0;
    syncPreviewDeckUI();
    renderQueue();
  }

  player.addEventListener("ended", () => {
    syncPreviewDeckUI();
    renderQueue();
  });

  function updateMasterPresetHighlights() {
    els.masterSpeedReadout.textContent = `${state.masterSpeed.toFixed(2)}x`;
    els.presetPills.forEach((btn) => {
      const val = Number(btn.dataset.speed);
      btn.classList.toggle("active", Math.abs(val - state.masterSpeed) < 0.01);
    });
  }

  function setMasterSpeed(val, applyToSelectedPreview) {
    state.masterSpeed = Math.max(0.5, Math.min(2.5, Number(val) || 1.0));
    els.masterSpeedSlider.value = state.masterSpeed;
    updateMasterPresetHighlights();

    if (applyToSelectedPreview) {
      const sel = getSelectedTrack();
      if (sel) {
        sel.speed = state.masterSpeed;
        if (state.playingTrackId === sel.id) {
          player.playbackRate = sel.speed;
        }
        renderQueue();
      }
    }
    syncPreviewDeckUI();
  }

  async function addFiles(fileList) {
    const files = Array.from(fileList || []);
    if (files.length === 0) return;

    let addedCount = 0;
    for (const file of files) {
      try {
        const decoded = await AudioEngine.decodeAudioFile(file);
        const track = {
          id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          file,
          audioBuffer: decoded.audioBuffer,
          duration: decoded.duration,
          sampleRate: decoded.sampleRate,
          channels: decoded.channels,
          peaks: decoded.peaks,
          displayName: AudioEngine.sanitizeDisplayName(file.name),
          speed: state.masterSpeed,
          preservePitch: state.masterPreservePitch,
          status: "idle",
          statusMessage: "",
          assetId: "",
          error: ""
        };
        state.tracks.push(track);
        addedCount++;
        if (!state.selectedTrackId) {
          state.selectedTrackId = track.id;
        }
      } catch (err) {
        showToast(`Gagal membaca "${file.name}": format tidak didukung browser.`, "error");
      }
    }

    if (addedCount > 0) {
      showToast(`${addedCount} file audio ditambahkan ke batch queue.`, "success");
      renderQueue();
      syncPreviewDeckUI();
    }
  }

  function getTargetInfo() {
    const type = state.config.defaultTarget === "group" ? "group" : "user";
    const id = type === "group" ? els.inputGroupId.value.trim() : els.inputUserId.value.trim();
    return { type, id };
  }

  function renderQueue() {
    els.queueCountPill.textContent = `${state.tracks.length} file`;
    const hasTracks = state.tracks.length > 0;
    els.queueEmptyState.hidden = hasTracks;
    els.btnDownloadAll.disabled = !hasTracks || state.busy;
    els.btnUploadAll.disabled = !hasTracks || state.busy;

    els.queueList.innerHTML = "";

    for (const track of state.tracks) {
      const adjDuration = track.duration / track.speed;
      const durationExceeded = adjDuration > AudioEngine.ROBLOX_MAX_DURATION_SEC;
      const wavPlan = AudioEngine.estimateWavPlan(adjDuration, track.channels, track.sampleRate);
      const isDirectBypass =
        state.formatMode === "auto" &&
        Math.abs(track.speed - 1.0) < 0.001 &&
        ["mp3", "ogg", "wav", "flac"].includes(AudioEngine.getExtension(track.file.name)) &&
        track.file.size <= AudioEngine.ROBLOX_MAX_BYTES;
      const estSizeText = isDirectBypass
        ? `${AudioEngine.formatBytes(track.file.size)} (Asli)`
        : state.ffmpegAvailable && (state.formatMode === "ogg" || state.formatMode === "mp3")
          ? `FFmpeg ${state.formatMode.toUpperCase()}`
          : `~${AudioEngine.formatBytes(wavPlan.estimatedBytes)} (${wavPlan.label})`;

      const isPlaying = state.playingTrackId === track.id && !player.paused;
      const isSelected = state.selectedTrackId === track.id;

      const card = document.createElement("div");
      card.className = `track-card${isSelected ? " is-selected" : ""}`;

      // Play button
      const playBtn = document.createElement("button");
      playBtn.type = "button";
      playBtn.className = `track-play-btn${isPlaying ? " playing" : ""}`;
      playBtn.title = "Putar / Pause Preview";
      playBtn.textContent = isPlaying ? "❚❚" : "▶";
      playBtn.addEventListener("click", () => togglePlayTrack(track.id));
      card.appendChild(playBtn);

      // Meta + Editable displayName
      const metaCol = document.createElement("div");
      metaCol.className = "track-meta-col";

      const nameInput = document.createElement("input");
      nameInput.type = "text";
      nameInput.className = "track-name-input";
      nameInput.maxLength = 50;
      nameInput.value = track.displayName;
      nameInput.placeholder = "Nama aset Roblox (displayName)";
      nameInput.addEventListener("input", (e) => {
        track.displayName = e.target.value;
        if (state.selectedTrackId === track.id) {
          els.previewTrackTitle.textContent = track.displayName || track.file.name;
        }
      });
      metaCol.appendChild(nameInput);

      const subMeta = document.createElement("div");
      subMeta.className = "track-sub-meta";
      const durBadgeClass = durationExceeded ? "badge-warn" : "badge-ok";
      subMeta.innerHTML = `
        <span>Asli: ${AudioEngine.formatTime(track.duration)}</span>
        <span class="${durBadgeClass}">Hasil: ${AudioEngine.formatTime(adjDuration)}${durationExceeded ? " (>7:00!)" : ""}</span>
        <span>${estSizeText}</span>
      `;
      metaCol.appendChild(subMeta);
      card.appendChild(metaCol);

      // Per-track Speed & Preserve Pitch
      const speedCol = document.createElement("div");
      speedCol.className = "track-speed-col";

      const speedTop = document.createElement("div");
      speedTop.className = "track-speed-top";
      const speedLabel = document.createElement("span");
      speedLabel.textContent = "Playback Speed:";
      const speedValStrong = document.createElement("strong");
      speedValStrong.textContent = `${track.speed.toFixed(2)}x`;
      speedTop.append(speedLabel, speedValStrong);
      speedCol.appendChild(speedTop);

      const trackSlider = document.createElement("input");
      trackSlider.type = "range";
      trackSlider.min = "0.5";
      trackSlider.max = "2.5";
      trackSlider.step = "0.05";
      trackSlider.value = String(track.speed);
      trackSlider.addEventListener("input", (e) => {
        track.speed = Number(e.target.value);
        speedValStrong.textContent = `${track.speed.toFixed(2)}x`;
        if (state.playingTrackId === track.id) {
          player.playbackRate = track.speed;
        }
        if (state.selectedTrackId === track.id) {
          syncPreviewDeckUI();
        }
      });
      trackSlider.addEventListener("change", () => renderQueue());
      speedCol.appendChild(trackSlider);

      const pitchLabel = document.createElement("label");
      pitchLabel.className = "track-pitch-toggle";
      const pitchCheck = document.createElement("input");
      pitchCheck.type = "checkbox";
      pitchCheck.checked = track.preservePitch;
      pitchCheck.addEventListener("change", (e) => {
        track.preservePitch = e.target.checked;
        if (state.playingTrackId === track.id) {
          applyPitchPreservation(player, track.preservePitch);
        }
        if (state.selectedTrackId === track.id) {
          syncPreviewDeckUI();
        }
      });
      const pitchText = document.createElement("span");
      pitchText.textContent = "Preserve Pitch";
      pitchLabel.append(pitchCheck, pitchText);
      speedCol.appendChild(pitchLabel);
      card.appendChild(speedCol);

      // Actions column
      const actionsCol = document.createElement("div");
      actionsCol.className = "track-actions-col";

      const btnSelect = document.createElement("button");
      btnSelect.type = "button";
      btnSelect.className = "btn-track-small";
      btnSelect.textContent = "Deck";
      btnSelect.title = "Tampilkan waveform di Preview Deck";
      btnSelect.addEventListener("click", () => loadAndPlayTrack(track, false));

      const btnDownload = document.createElement("button");
      btnDownload.type = "button";
      btnDownload.className = "btn-track-small";
      btnDownload.textContent = track.status === "rendering" ? "Proses..." : "Download";
      btnDownload.disabled = state.busy || track.status === "uploading";
      btnDownload.addEventListener("click", () => downloadSingleTrack(track));

      const btnUpload = document.createElement("button");
      btnUpload.type = "button";
      btnUpload.className = "btn-track-small upload";
      btnUpload.textContent = track.status === "uploading" ? "Uploading..." : "Upload Roblox";
      btnUpload.disabled = state.busy || durationExceeded;
      btnUpload.addEventListener("click", () => uploadSingleTrack(track));

      const btnRemove = document.createElement("button");
      btnRemove.type = "button";
      btnRemove.className = "btn-track-small remove";
      btnRemove.textContent = "✕";
      btnRemove.title = "Hapus dari antrean";
      btnRemove.disabled = state.busy;
      btnRemove.addEventListener("click", () => removeTrack(track.id));

      actionsCol.append(btnSelect, btnDownload, btnUpload, btnRemove);
      card.appendChild(actionsCol);

      // Result / status row
      if (track.assetId || track.error || track.statusMessage) {
        const resRow = document.createElement("div");
        resRow.className = "track-result-row";

        if (track.assetId) {
          const assetUri = `rbxassetid://${track.assetId}`;
          const pill = document.createElement("span");
          pill.className = "asset-id-pill";
          pill.textContent = `Sukses: ${assetUri}`;

          const copyBtn = document.createElement("button");
          copyBtn.type = "button";
          copyBtn.className = "btn-track-small";
          copyBtn.textContent = "Copy Asset ID";
          copyBtn.addEventListener("click", () => {
            navigator.clipboard.writeText(assetUri);
            showToast(`Disalin: ${assetUri}`, "success");
          });

          resRow.append(pill, copyBtn);
        } else if (track.error) {
          const errSpan = document.createElement("span");
          errSpan.className = "error-pill";
          errSpan.textContent = track.error;
          resRow.appendChild(errSpan);
        } else if (track.statusMessage) {
          const msgSpan = document.createElement("span");
          msgSpan.textContent = track.statusMessage;
          resRow.appendChild(msgSpan);
        }

        card.appendChild(resRow);
      }

      els.queueList.appendChild(card);
    }
  }

  function removeTrack(trackId) {
    if (state.playingTrackId === trackId) {
      stopPreview();
      state.playingTrackId = null;
    }
    state.tracks = state.tracks.filter((t) => t.id !== trackId);
    if (state.selectedTrackId === trackId) {
      state.selectedTrackId = state.tracks[0] ? state.tracks[0].id : null;
    }
    renderQueue();
    syncPreviewDeckUI();
  }

  function triggerBrowserDownload(blob, fileName) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }

  async function downloadSingleTrack(track) {
    try {
      track.status = "rendering";
      track.error = "";
      track.statusMessage = "Merender audio...";
      renderQueue();

      const rendered = await AudioEngine.renderTrackToBlob(track, {
        formatMode: state.formatMode,
        ffmpegAvailable: state.ffmpegAvailable
      });

      triggerBrowserDownload(rendered.blob, rendered.fileName);
      track.status = "idle";
      track.statusMessage = `Siap (${rendered.modeLabel} · ${AudioEngine.formatBytes(rendered.blob.size)})`;
      showToast(`Berhasil download ${rendered.fileName}`, "success");
    } catch (err) {
      track.status = "error";
      track.error = err.message;
      showToast(err.message, "error");
    } finally {
      renderQueue();
    }
  }

  function getEffectiveSessionKey() {
    const typed = els.inputApiKey.value.trim();
    if (typed) return typed;
    return state.sessionApiKey || "";
  }

  function hasEffectiveApiKey() {
    if (state.config.mode === "shared") {
      return Boolean(getEffectiveSessionKey());
    }
    return Boolean(getEffectiveSessionKey() || state.config.hasApiKey);
  }

  function sleepMs(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function uploadSingleTrack(track) {
    const target = getTargetInfo();
    const sessionKey = getEffectiveSessionKey();
    if (!hasEffectiveApiKey()) {
      const msg = state.config.mode === "shared"
        ? "Masukkan Roblox Open Cloud API Key milikmu di bagian Roblox Target (hanya tersimpan di browsermu)."
        : "Simpan ROBLOX_API_KEY ke .env lokal terlebih dahulu di bagian Roblox Target.";
      showToast(msg, "error");
      document.getElementById("roblox-target").scrollIntoView({ behavior: "smooth" });
      return false;
    }
    if (!/^\d+$/.test(target.id)) {
      showToast(`Isi ${target.type === "group" ? "Group ID" : "User ID"} Roblox berupa angka terlebih dahulu.`, "error");
      document.getElementById("roblox-target").scrollIntoView({ behavior: "smooth" });
      return false;
    }

    const adjDur = track.duration / track.speed;
    if (adjDur > AudioEngine.ROBLOX_MAX_DURATION_SEC) {
      track.error = "Durasi hasil melebihi batas maksimal 7 menit Roblox.";
      renderQueue();
      return false;
    }

    try {
      track.status = "uploading";
      track.error = "";
      track.statusMessage = "Merender audio sebelum upload...";
      renderQueue();

      const rendered = await AudioEngine.renderTrackToBlob(track, {
        formatMode: state.formatMode,
        ffmpegAvailable: state.ffmpegAvailable
      });

      if (rendered.blob.size > AudioEngine.ROBLOX_MAX_BYTES) {
        throw new Error(`Ukuran ${AudioEngine.formatBytes(rendered.blob.size)} melebihi batas 20 MB Roblox.`);
      }

      track.statusMessage = `Mengunggah ke Roblox (${target.type.toUpperCase()} ${target.id})...`;
      renderQueue();

      const meta = {
        displayName: AudioEngine.sanitizeDisplayName(track.displayName || track.file.name),
        description: `Uploaded from Harles Studio (${track.speed.toFixed(2)}x)`,
        creatorType: target.type,
        creatorId: target.id,
        mimeType: rendered.mimeType,
        fileName: rendered.fileName
      };

      const headers = {
        "Content-Type": "application/octet-stream",
        "X-Harles-Meta": AudioEngine.encodeBase64Utf8(JSON.stringify(meta))
      };
      if (sessionKey) {
        headers["X-Roblox-Api-Key"] = sessionKey;
      }

      const resp = await fetch("/api/roblox/upload", {
        method: "POST",
        headers,
        body: rendered.blob
      });

      const payload = await resp.json();
      if (!resp.ok || !payload.ok) {
        throw new Error(payload.error || `Upload gagal (HTTP ${resp.status})`);
      }

      let finalAssetId = payload.assetId || "";
      if (!payload.done && payload.operationPath) {
        const opPath = payload.operationPath;
        const pollHeaders = sessionKey ? { "X-Roblox-Api-Key": sessionKey } : {};
        for (let attempt = 1; attempt <= 40; attempt++) {
          track.statusMessage = `Menunggu moderasi/proses Roblox... (cek ${attempt}/40)`;
          renderQueue();
          await sleepMs(2500);

          const pollResp = await fetch(`/api/roblox/operation?path=${encodeURIComponent(opPath)}`, {
            headers: pollHeaders
          });
          const pollData = await pollResp.json();
          if (!pollResp.ok || !pollData.ok) {
            throw new Error(pollData.error || `Gagal mengecek status Roblox (HTTP ${pollResp.status})`);
          }
          if (pollData.done) {
            finalAssetId = pollData.assetId || "";
            break;
          }
        }
      }

      if (!finalAssetId) {
        throw new Error("Timeout menunggu hasil Roblox. Periksa Creator Dashboard nanti.");
      }

      track.status = "done";
      track.assetId = finalAssetId;
      track.statusMessage = "";
      showToast(`Upload berhasil! rbxassetid://${finalAssetId}`, "success");
      return true;
    } catch (err) {
      track.status = "error";
      track.error = err.message;
      showToast(err.message, "error");
      return false;
    } finally {
      renderQueue();
    }
  }

  async function runBatchDownload() {
    if (state.busy || state.tracks.length === 0) return;
    state.busy = true;
    els.batchProgressBarWrap.hidden = false;

    for (let i = 0; i < state.tracks.length; i++) {
      els.batchProgressLabel.textContent = `Merender & mengunduh: ${state.tracks[i].displayName}`;
      els.batchProgressCount.textContent = `${i + 1}/${state.tracks.length}`;
      els.batchProgressFill.style.width = `${Math.round(((i + 1) / state.tracks.length) * 100)}%`;
      await downloadSingleTrack(state.tracks[i]);
    }

    state.busy = false;
    renderQueue();
    setTimeout(() => {
      els.batchProgressBarWrap.hidden = true;
    }, 1500);
  }

  async function runBatchUpload() {
    if (state.busy || state.tracks.length === 0) return;
    state.busy = true;
    els.batchProgressBarWrap.hidden = false;

    let successCount = 0;
    for (let i = 0; i < state.tracks.length; i++) {
      els.batchProgressLabel.textContent = `Mengunggah ke Roblox: ${state.tracks[i].displayName}`;
      els.batchProgressCount.textContent = `${i + 1}/${state.tracks.length}`;
      els.batchProgressFill.style.width = `${Math.round(((i + 1) / state.tracks.length) * 100)}%`;
      const ok = await uploadSingleTrack(state.tracks[i]);
      if (ok) successCount++;
    }

    state.busy = false;
    renderQueue();
    showToast(`Batch selesai: ${successCount} dari ${state.tracks.length} audio berhasil masuk Roblox.`, successCount > 0 ? "success" : "error");
    setTimeout(() => {
      els.batchProgressBarWrap.hidden = true;
    }, 2000);
  }

  function syncTargetTabs() {
    const isGroup = state.config.defaultTarget === "group";
    els.tabTargetUser.classList.toggle("active", !isGroup);
    els.tabTargetGroup.classList.toggle("active", isGroup);
  }

  function updateConfigUI(cfg) {
    state.config = { ...state.config, ...cfg };
    state.ffmpegAvailable = Boolean(cfg.ffmpegAvailable);
    const isShared = state.config.mode === "shared";

    els.shareModeBanner.hidden = !isShared;
    if (isShared) {
      const savedSession = readSessionPrefs();
      state.config.defaultTarget = savedSession.defaultTarget || "user";
      state.sessionApiKey = savedSession.apiKey || "";
      els.inputUserId.value = savedSession.userId || "";
      els.inputGroupId.value = savedSession.groupId || "";
      els.btnSaveRobloxConfig.textContent = "Pakai di Sesi Ini";
      els.inputApiKey.placeholder = "Tempel API Key Roblox milikmu untuk sesi browser ini";
      if (state.sessionApiKey) {
        const tail = state.sessionApiKey.length > 4 ? state.sessionApiKey.slice(-4) : "****";
        els.apiKeyStatusBadge.textContent = `Aktif di sesi browser (••••${tail})`;
        els.apiKeyStatusBadge.className = "status-badge saved";
      } else {
        els.apiKeyStatusBadge.textContent = "Isi API Key milikmu di sesi ini";
        els.apiKeyStatusBadge.className = "status-badge pending";
      }
      els.apiKeyHelpNote.textContent = "Mode Berbagi aktif: API Key hanya disimpan sementara di sessionStorage browser-mu sendiri (hilang saat tab ditutup) dan tidak disimpan di server.";
    } else {
      els.inputUserId.value = cfg.userId || "";
      els.inputGroupId.value = cfg.groupId || "";
      els.btnSaveRobloxConfig.textContent = "Simpan ke .env";
      els.inputApiKey.placeholder = "Tempel API Key baru untuk disimpan ke .env lokal (kosongkan jika tidak diubah)";
      if (cfg.hasApiKey) {
        els.apiKeyStatusBadge.textContent = `Tersimpan di .env (${cfg.maskedKey})`;
        els.apiKeyStatusBadge.className = "status-badge saved";
      } else {
        els.apiKeyStatusBadge.textContent = "Belum tersimpan di .env";
        els.apiKeyStatusBadge.className = "status-badge pending";
      }
    }
    syncTargetTabs();

    if (state.ffmpegAvailable) {
      els.heroEngineBadge.textContent = isShared ? "Shared Mode + FFmpeg" : "Localhost + FFmpeg Ready";
      els.footerFfmpegStatus.textContent = "Engine: FFmpeg Detected + Web Audio";
      if (!els.exportFormatSelect.querySelector('option[value="ogg"]')) {
        const optOgg = new Option("FFmpeg .OGG (Ukuran Kecil)", "ogg");
        const optMp3 = new Option("FFmpeg .MP3 (192 kbps)", "mp3");
        els.exportFormatSelect.append(optOgg, optMp3);
      }
    } else {
      els.heroEngineBadge.textContent = isShared ? "Shared BYOK Web Audio" : "100% Localhost Web Audio";
      els.footerFfmpegStatus.textContent = "Engine: Built-in Web Audio (Zero-Install)";
    }
  }

  function readSessionPrefs() {
    try {
      const raw = sessionStorage.getItem("harles_studio_byok");
      return raw ? JSON.parse(raw) : {};
    } catch {
      return {};
    }
  }

  function writeSessionPrefs(prefs) {
    try {
      sessionStorage.setItem("harles_studio_byok", JSON.stringify(prefs));
    } catch {}
  }

  async function loadServerConfig() {
    try {
      const resp = await fetch("/api/config");
      const data = await resp.json();
      if (data.ok) {
        updateConfigUI(data);
      }
    } catch (err) {
      showToast("Tidak bisa terhubung ke server lokal Harles Studio.", "error");
    }
  }

  // Wire UI Events
  els.navPills.forEach((pill) => {
    pill.addEventListener("click", () => {
      els.navPills.forEach((p) => p.classList.remove("active"));
      pill.classList.add("active");
    });
  });

  els.btnPickFiles.addEventListener("click", () => els.audioFileInput.click());
  els.audioFileInput.addEventListener("change", (e) => {
    addFiles(e.target.files);
    e.target.value = "";
  });

  els.dropZone.addEventListener("dragover", (e) => {
    e.preventDefault();
    els.dropZone.classList.add("drag-over");
  });
  els.dropZone.addEventListener("dragleave", () => {
    els.dropZone.classList.remove("drag-over");
  });
  els.dropZone.addEventListener("drop", (e) => {
    e.preventDefault();
    els.dropZone.classList.remove("drag-over");
    addFiles(e.dataTransfer.files);
  });

  els.btnClearAll.addEventListener("click", () => {
    stopPreview();
    state.tracks = [];
    state.selectedTrackId = null;
    state.playingTrackId = null;
    renderQueue();
    syncPreviewDeckUI();
  });

  els.masterSpeedSlider.addEventListener("input", (e) => {
    setMasterSpeed(e.target.value, true);
  });
  els.presetPills.forEach((btn) => {
    btn.addEventListener("click", () => setMasterSpeed(btn.dataset.speed, true));
  });

  els.masterPreservePitch.addEventListener("change", (e) => {
    state.masterPreservePitch = e.target.checked;
    const sel = getSelectedTrack();
    if (sel) {
      sel.preservePitch = state.masterPreservePitch;
      if (state.playingTrackId === sel.id) {
        applyPitchPreservation(player, sel.preservePitch);
      }
      renderQueue();
    }
    syncPreviewDeckUI();
  });

  els.exportFormatSelect.addEventListener("change", (e) => {
    state.formatMode = e.target.value;
    renderQueue();
  });

  els.btnApplyMasterAll.addEventListener("click", () => {
    if (state.tracks.length === 0) {
      showToast("Tambahkan file audio terlebih dahulu.", "error");
      return;
    }
    state.tracks.forEach((t) => {
      t.speed = state.masterSpeed;
      t.preservePitch = state.masterPreservePitch;
    });
    if (state.playingTrackId) {
      player.playbackRate = state.masterSpeed;
      applyPitchPreservation(player, state.masterPreservePitch);
    }
    renderQueue();
    syncPreviewDeckUI();
    showToast(`Speed ${state.masterSpeed.toFixed(2)}x diterapkan ke semua ${state.tracks.length} track.`, "success");
  });

  els.btnPreviewPlay.addEventListener("click", () => {
    const sel = getSelectedTrack();
    if (sel) togglePlayTrack(sel.id);
  });
  els.btnPreviewStop.addEventListener("click", stopPreview);

  els.previewVolume.addEventListener("input", (e) => {
    player.volume = Number(e.target.value);
  });

  els.previewSeekBar.addEventListener("input", (e) => {
    const sel = getSelectedTrack();
    if (!sel) return;
    const ratio = Number(e.target.value) / 1000;
    if (state.playingTrackId !== sel.id) {
      loadAndPlayTrack(sel, false);
    }
    player.currentTime = ratio * sel.duration;
    syncPreviewDeckUI();
  });

  els.waveformCanvas.addEventListener("click", (e) => {
    const sel = getSelectedTrack();
    if (!sel) return;
    const rect = els.waveformCanvas.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    if (state.playingTrackId !== sel.id) {
      loadAndPlayTrack(sel, false);
    }
    player.currentTime = ratio * sel.duration;
    syncPreviewDeckUI();
  });

  els.btnDownloadAll.addEventListener("click", runBatchDownload);
  els.btnUploadAll.addEventListener("click", runBatchUpload);

  els.tabTargetUser.addEventListener("click", () => {
    state.config.defaultTarget = "user";
    syncTargetTabs();
  });
  els.tabTargetGroup.addEventListener("click", () => {
    state.config.defaultTarget = "group";
    syncTargetTabs();
  });

  els.robloxConfigForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (state.config.mode === "shared") {
      const enteredKey = els.inputApiKey.value.trim();
      const nextKey = enteredKey || state.sessionApiKey;
      const prefs = {
        defaultTarget: state.config.defaultTarget,
        userId: els.inputUserId.value.trim(),
        groupId: els.inputGroupId.value.trim(),
        apiKey: nextKey
      };
      writeSessionPrefs(prefs);
      els.inputApiKey.value = "";
      updateConfigUI(state.config);
      showToast("Target & API Key disimpan hanya di sesi browser-mu.", "success");
      return;
    }

    try {
      const payload = {
        defaultTarget: state.config.defaultTarget,
        userId: els.inputUserId.value.trim(),
        groupId: els.inputGroupId.value.trim(),
        apiKey: els.inputApiKey.value.trim()
      };
      const resp = await fetch("/api/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      const data = await resp.json();
      if (!resp.ok || !data.ok) {
        throw new Error(data.error || "Gagal menyimpan konfigurasi ke .env");
      }
      els.inputApiKey.value = "";
      updateConfigUI(data);
      showToast("Konfigurasi Roblox Target & .env lokal berhasil disimpan.", "success");
    } catch (err) {
      showToast(err.message, "error");
    }
  });

  drawWaveform(null, 0);
  loadServerConfig();
})();
