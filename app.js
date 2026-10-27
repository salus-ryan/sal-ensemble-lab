"use strict";

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const controls = {
  members: $("#members"), register: $("#register"), tone: $("#tone"),
  width: $("#width"), delay: $("#delay"), shimmer: $("#shimmer"), ambience: $("#ambience")
};
const defaults = { members: 5, register: 0, tone: 0, width: 100, delay: 8, shimmer: 0, ambience: 0 };
const presets = {
  canonical: { ...defaults, name: "Canonical Sal" },
  solo: { ...defaults, members: 1, width: 0, delay: 0, name: "Single signal" },
  deep: { ...defaults, register: -3, tone: -50, width: 115, delay: 11, ambience: 8, name: "Deep structure" },
  airy: { ...defaults, register: 2, tone: 60, width: 135, delay: 12, shimmer: 10, ambience: 16, name: "Airy chorus" },
  mono: { ...defaults, width: 0, delay: 2, name: "Mono compatibility" }
};
const memberPans = [-0.7, -0.35, 0, 0.35, 0.7];
const memberSpread = [-1, -0.5, 0, 0.5, 1];
const selections = { 1: [2], 2: [1, 3], 3: [0, 2, 4], 4: [0, 1, 3, 4], 5: [0, 1, 2, 3, 4] };
let audioContext = null;
let buffers = [];
let sources = [];
let analyser = null;
let playing = false;
let startedAt = 0;
let estimatedDuration = 11.92;
let animationFrame = 0;
let currentPreset = "canonical";

function values() {
  return Object.fromEntries(Object.entries(controls).map(([key, element]) => [key, Number(element.value)]));
}

function recipe() {
  const v = values();
  return {
    schema: "sal-ensemble-audition-v1",
    checkpoint: "checkpoint_39500.pth",
    development_only: true,
    members: v.members,
    member_indices: selections[v.members].map(i => i + 1),
    shared_phoneme_alignment: true,
    equal_member_weights: true,
    register_semitones: v.register,
    tone: v.tone / 100,
    stereo_width: v.width / 100,
    maximum_delay_ms: v.delay,
    member_variation_cents: v.shimmer,
    ambience: v.ambience / 100,
    gender_label: null,
    identity_note: "Acoustic presentation is not gender identity.",
    source_provenance: "assets/provenance.json"
  };
}

function toneLabel(value) {
  if (value <= -55) return "dark";
  if (value < -10) return "warm";
  if (value <= 10) return "balanced";
  if (value < 55) return "clear";
  return "bright";
}

function updateUI(markCustom = true) {
  const v = values();
  $("#members-out").textContent = String(v.members);
  $("#register-out").textContent = `${v.register > 0 ? "+" : ""}${v.register} st`;
  $("#tone-out").textContent = toneLabel(v.tone);
  $("#width-out").textContent = `${v.width}%`;
  $("#delay-out").textContent = `${v.delay} ms`;
  $("#shimmer-out").textContent = `${v.shimmer} ct`;
  $("#ambience-out").textContent = `${v.ambience}%`;
  $("#recipe-json").textContent = JSON.stringify(recipe(), null, 2);
  const selected = new Set(selections[v.members]);
  $$(".member-dot").forEach((dot, index) => dot.classList.toggle("active", selected.has(index)));
  if (markCustom) {
    currentPreset = "custom";
    $("#preset-name").textContent = "Custom audition";
    $$(".preset-row button").forEach(button => button.classList.remove("active"));
  }
}

function applyPreset(name) {
  const preset = presets[name];
  Object.keys(defaults).forEach(key => { controls[key].value = preset[key]; });
  currentPreset = name;
  $("#preset-name").textContent = preset.name;
  $$(".preset-row button").forEach(button => button.classList.toggle("active", button.dataset.preset === name));
  updateUI(false);
  if (playing) play();
}

function makeImpulse(context, seconds = 1.15) {
  const length = Math.floor(context.sampleRate * seconds);
  const impulse = context.createBuffer(2, length, context.sampleRate);
  let seed = 1701;
  const random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  for (let channel = 0; channel < 2; channel += 1) {
    const data = impulse.getChannelData(channel);
    for (let i = 0; i < length; i += 1) {
      const envelope = Math.pow(1 - i / length, 2.8);
      data[i] = (random() * 2 - 1) * envelope;
    }
  }
  return impulse;
}

async function loadAudio() {
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) throw new Error("This browser does not support Web Audio.");
  audioContext = new AudioCtx();
  const files = [1, 2, 3, 4, 5].map(i => `assets/member-${i}.mp3`);
  buffers = await Promise.all(files.map(async path => {
    const response = await fetch(path);
    if (!response.ok) throw new Error(`Could not load ${path}`);
    return audioContext.decodeAudioData(await response.arrayBuffer());
  }));
  estimatedDuration = Math.max(...buffers.map(buffer => buffer.duration));
  $("#load-state").textContent = "Ready · five real aligned member passes · use headphones for width";
  $("#load-state").className = "load-state ready";
  $("#play").disabled = false;
  drawVisualizer();
}

function stop(updateLabel = true) {
  sources.forEach(source => { try { source.stop(); } catch (_) {} });
  sources = [];
  playing = false;
  if (updateLabel) {
    $("#play .play-icon").textContent = "▶";
    $("#play .play-label").textContent = "Play configuration";
  }
  $("#progress").style.width = "0%";
  $("#time").textContent = `0:00 / 0:${Math.ceil(estimatedDuration).toString().padStart(2, "0")}`;
}

async function play() {
  if (!audioContext || !buffers.length) return;
  stop(false);
  await audioContext.resume();
  const v = values();
  const chosen = selections[v.members];
  const mix = audioContext.createGain();
  const lowShelf = audioContext.createBiquadFilter();
  const highShelf = audioContext.createBiquadFilter();
  const compressor = audioContext.createDynamicsCompressor();
  const dry = audioContext.createGain();
  const wet = audioContext.createGain();
  const convolver = audioContext.createConvolver();
  analyser = audioContext.createAnalyser();

  lowShelf.type = "lowshelf";
  lowShelf.frequency.value = 240;
  lowShelf.gain.value = -v.tone * 0.045;
  highShelf.type = "highshelf";
  highShelf.frequency.value = 3200;
  highShelf.gain.value = v.tone * 0.055;
  compressor.threshold.value = -18;
  compressor.knee.value = 18;
  compressor.ratio.value = 3;
  compressor.attack.value = 0.008;
  compressor.release.value = 0.18;
  dry.gain.value = 1;
  wet.gain.value = v.ambience / 100 * 0.72;
  convolver.buffer = makeImpulse(audioContext);
  analyser.fftSize = 1024;
  analyser.smoothingTimeConstant = 0.78;

  mix.connect(lowShelf).connect(highShelf).connect(compressor).connect(analyser);
  analyser.connect(dry).connect(audioContext.destination);
  analyser.connect(convolver).connect(wet).connect(audioContext.destination);

  const launch = audioContext.currentTime + 0.08;
  const level = 0.78 / Math.sqrt(chosen.length);
  chosen.forEach((memberIndex, activeIndex) => {
    const source = audioContext.createBufferSource();
    const delay = audioContext.createDelay(0.1);
    const panner = audioContext.createStereoPanner();
    const gain = audioContext.createGain();
    source.buffer = buffers[memberIndex];
    source.detune.value = v.register * 100 + memberSpread[memberIndex] * v.shimmer;
    delay.delayTime.value = chosen.length === 1 ? 0 : (activeIndex / (chosen.length - 1)) * v.delay / 1000;
    panner.pan.value = Math.max(-1, Math.min(1, memberPans[memberIndex] * v.width / 100));
    gain.gain.value = level;
    source.connect(delay).connect(panner).connect(gain).connect(mix);
    source.start(launch);
    sources.push(source);
  });

  const rate = Math.pow(2, v.register / 12);
  estimatedDuration = Math.max(...chosen.map(i => buffers[i].duration)) / rate + v.ambience / 100 * 0.6;
  startedAt = launch;
  playing = true;
  $("#play .play-icon").textContent = "↻";
  $("#play .play-label").textContent = "Replay configuration";
  window.clearTimeout(play.endTimer);
  play.endTimer = window.setTimeout(() => stop(), (estimatedDuration + 0.2) * 1000);
}

function formatTime(seconds) {
  const safe = Math.max(0, seconds);
  return `${Math.floor(safe / 60)}:${Math.floor(safe % 60).toString().padStart(2, "0")}`;
}

function drawVisualizer() {
  const canvas = $("#visualizer");
  const context = canvas.getContext("2d");
  const ratio = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const targetWidth = Math.max(1, Math.round(rect.width * ratio));
  const targetHeight = Math.max(1, Math.round(rect.height * ratio));
  if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
    canvas.width = targetWidth; canvas.height = targetHeight;
  }
  const width = canvas.width; const height = canvas.height;
  context.clearRect(0, 0, width, height);
  const gradient = context.createLinearGradient(0, 0, width, 0);
  gradient.addColorStop(0, "rgba(157,124,255,.12)");
  gradient.addColorStop(.5, "rgba(87,216,255,.92)");
  gradient.addColorStop(1, "rgba(157,124,255,.12)");
  context.lineWidth = 2 * ratio;
  context.strokeStyle = gradient;
  context.beginPath();

  if (playing && analyser) {
    const data = new Uint8Array(analyser.fftSize);
    analyser.getByteTimeDomainData(data);
    data.forEach((sample, index) => {
      const x = index / (data.length - 1) * width;
      const y = sample / 255 * height;
      if (index === 0) context.moveTo(x, y); else context.lineTo(x, y);
    });
    const elapsed = Math.max(0, audioContext.currentTime - startedAt);
    $("#progress").style.width = `${Math.min(100, elapsed / estimatedDuration * 100)}%`;
    $("#time").textContent = `${formatTime(elapsed)} / ${formatTime(estimatedDuration)}`;
  } else {
    const v = values();
    const time = performance.now() / 1000;
    for (let x = 0; x < width; x += 3 * ratio) {
      const normalized = x / width;
      const envelope = Math.sin(normalized * Math.PI);
      const wave = Math.sin(normalized * 24 + time * .8) * (12 + v.members * 2) * ratio;
      const shimmer = Math.sin(normalized * 67 - time * .4) * v.shimmer * .16 * ratio;
      const y = height / 2 + (wave + shimmer) * envelope;
      if (x === 0) context.moveTo(x, y); else context.lineTo(x, y);
    }
  }
  context.stroke();
  animationFrame = requestAnimationFrame(drawVisualizer);
}

function downloadRecipe() {
  const blob = new Blob([`${JSON.stringify(recipe(), null, 2)}\n`], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = "sal-recipe.json";
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

async function copyWithFeedback(button, value) {
  await navigator.clipboard.writeText(value);
  const previous = button.textContent;
  button.textContent = "Copied";
  window.setTimeout(() => { button.textContent = previous; }, 1200);
}

function validateNarrationText() {
  const text = $("#script-text").value.trim();
  const singular = /\b(?:i|me|my|mine|myself)\b/i.exec(text);
  const falseClaim = /\b(?:we\s+(?:agree|decide|decided|judge|judged|allow|allowed|deny|denied)|our\s+consensus)\b/i.exec(text);
  const status = $("#text-status");
  const button = $("#copy-tts-command");
  let message = "✓ Plural self-reference and role boundary pass";
  if (!text) message = "Enter narration text before rendering.";
  else if (singular) message = `Use we/us/our instead of singular “${singular[0]}”.`;
  else if (falseClaim) message = `Attribute “${falseClaim[0]}” to the actual decision system.`;
  const valid = message.startsWith("✓");
  status.textContent = message;
  status.className = `text-status ${valid ? "valid" : "invalid"}`;
  button.disabled = !valid;
  return valid;
}

async function copyTtsCommand() {
  if (!validateNarrationText()) return;
  const text = $("#script-text").value.trim();
  let delimiter = "SAL_NARRATION_1701";
  while (text.split("\n").includes(delimiter)) delimiter += "X";
  const command = `cd ~/agent-kernel\ncat > /tmp/sal-script.txt <<'${delimiter}'\n${text}\n${delimiter}\nTEXT="$(tr '\\n' ' ' < /tmp/sal-script.txt)"\nMODAL_PROFILE=salus modal run --detach marketing/sal_voice/train_modal.py::render_development \\\n  --text "$TEXT" \\\n  --checkpoint-name checkpoint_39500.pth`;
  await copyWithFeedback($("#copy-tts-command"), command);
}

async function copyMixCommand() {
  const command = "python render_recipe.py --recipe sal-recipe.json --assets-dir assets --output sal-custom.wav";
  await copyWithFeedback($("#copy-mix-command"), command);
}

function initialize() {
  const orbit = $("#member-orbit");
  for (let index = 0; index < 5; index += 1) {
    const dot = document.createElement("span");
    dot.className = "member-dot active";
    dot.style.setProperty("--i", index);
    dot.title = `Member ${index + 1}`;
    orbit.appendChild(dot);
  }
  Object.values(controls).forEach(control => control.addEventListener("input", () => updateUI(true)));
  $$(".preset-row button").forEach(button => button.addEventListener("click", () => applyPreset(button.dataset.preset)));
  $("#play").addEventListener("click", play);
  $("#stop").addEventListener("click", () => stop());
  $("#reset").addEventListener("click", () => applyPreset("canonical"));
  $("#download-recipe").addEventListener("click", downloadRecipe);
  $("#copy-tts-command").addEventListener("click", copyTtsCommand);
  $("#copy-mix-command").addEventListener("click", copyMixCommand);
  $("#script-text").addEventListener("input", validateNarrationText);
  $("#play").disabled = true;
  updateUI(false);
  loadAudio().catch(error => {
    $("#load-state").textContent = `${error.message} Serve this directory over HTTP instead of opening file:// directly.`;
    $("#load-state").className = "load-state error";
    drawVisualizer();
  });
}

window.addEventListener("beforeunload", () => { cancelAnimationFrame(animationFrame); stop(false); });
initialize();
