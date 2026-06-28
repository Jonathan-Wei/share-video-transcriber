const form = document.querySelector("#download-form");
const submit = document.querySelector("#submit");
const tasksEl = document.querySelector("#tasks");
const template = document.querySelector("#task-template");
const formError = document.querySelector("#form-error");
const asrStatus = document.querySelector("#asr-status");
const emptyState = document.querySelector("#empty-state");
const llmMenu = document.querySelector("#llm-menu");
const llmConfigForm = document.querySelector("#llm-config-form");
const llmConfigToggle = document.querySelector("#llm-config-toggle");
const llmConfigSummary = document.querySelector("#llm-config-summary");
const llmProvider = document.querySelector("#llm-provider");
const llmModel = document.querySelector("#llm-model");
const llmBaseUrl = document.querySelector("#llm-base-url");
const llmApiKey = document.querySelector("#llm-api-key");
const llmTimeout = document.querySelector("#llm-timeout");
const llmConfigStatus = document.querySelector("#llm-config-status");
const llmSave = document.querySelector("#llm-save");
const taskNodes = new Map();
const activeTasks = new Set();

const llmDefaults = {
  deepseek: {
    model: "deepseek-chat",
    base_url: "https://api.deepseek.com",
  },
  aliyun: {
    model: "qwen-plus",
    base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  },
  custom: {
    model: "",
    base_url: "",
  },
};

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  formError.textContent = "";
  const urlValue = document.querySelector("#url").value.trim();
  if (!/^https?:\/\//i.test(urlValue) && !/https?:\/\/\S+/i.test(urlValue)) {
    formError.textContent = "请粘贴包含 http 或 https 链接的分享内容。";
    document.querySelector("#url").focus();
    return;
  }

  submit.disabled = true;
  submit.textContent = "创建中...";

  const payload = {
    url: urlValue,
    output_name: document.querySelector("#output-name").value.trim() || null,
    timeout: Number(document.querySelector("#timeout").value) || 30000,
    headful: document.querySelector("#headful").checked,
    transcribe: document.querySelector("#transcribe").checked,
  };

  try {
    const task = await api("/api/downloads", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    renderTask(task);
    activeTasks.add(task.id);
    pollTask(task.id);
  } catch (error) {
    alert(error.message);
  } finally {
    submit.disabled = false;
    submit.textContent = "开始下载";
  }
});

llmProvider.addEventListener("change", () => {
  applyProviderDefaults(llmProvider.value, { onlyEmpty: false });
});

llmConfigToggle.addEventListener("click", () => {
  setLlmMenuOpen(llmConfigForm.hidden);
});

document.addEventListener("click", (event) => {
  if (!llmMenu.contains(event.target)) {
    setLlmMenuOpen(false);
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    setLlmMenuOpen(false);
  }
});

llmConfigForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  await saveLlmConfig();
});

loadAsrStatus();
loadLlmConfig();
loadTasks();

async function loadAsrStatus() {
  try {
    const status = await api("/api/asr/status");
    if (status.ready && status.provider === "remote") {
      asrStatus.textContent = "远程 ASR 已就绪";
    } else {
      asrStatus.textContent = status.ready ? `ASR 已就绪 · ${status.model}` : "ASR 未就绪";
    }
    asrStatus.className = status.ready ? "badge badge-ok" : "badge badge-warn";
    if (status.error) asrStatus.title = status.error;
  } catch {
    asrStatus.textContent = "ASR 状态未知";
    asrStatus.className = "badge badge-warn";
  }
}

async function loadLlmConfig() {
  try {
    const config = await api("/api/ai/config");
    llmProvider.value = config.provider || "deepseek";
    llmModel.value = config.model || "";
    llmBaseUrl.value = config.base_url || "";
    llmTimeout.value = config.timeout || 60;
    llmApiKey.value = "";
    llmApiKey.placeholder = config.api_key_configured
      ? `已配置 ${config.api_key_masked}`
      : "保存后仅显示脱敏状态";
    llmConfigStatus.textContent = config.api_key_configured
      ? `当前使用 ${providerLabel(config.provider)} · ${config.model}`
      : "尚未配置 API Key";
    llmConfigStatus.className = config.api_key_configured ? "config-status ok" : "config-status warn";
    updateLlmSummary(config);
  } catch (error) {
    llmConfigStatus.textContent = `模型配置读取失败：${error.message}`;
    llmConfigStatus.className = "config-status warn";
    updateLlmSummary({ api_key_configured: false, provider: "", model: "" });
  }
}

async function saveLlmConfig() {
  llmSave.disabled = true;
  llmSave.textContent = "保存中...";
  llmConfigStatus.textContent = "正在保存模型配置";

  try {
    const payload = {
      provider: llmProvider.value,
      api_key: llmApiKey.value.trim(),
      model: llmModel.value.trim(),
      base_url: llmBaseUrl.value.trim(),
      timeout: Number(llmTimeout.value) || 60,
    };
    const config = await api("/api/ai/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    llmProvider.value = config.provider || payload.provider;
    llmModel.value = config.model || "";
    llmBaseUrl.value = config.base_url || "";
    llmTimeout.value = config.timeout || payload.timeout;
    llmApiKey.value = "";
    llmApiKey.placeholder = config.api_key_configured
      ? `已配置 ${config.api_key_masked}`
      : "保存后仅显示脱敏状态";
    llmConfigStatus.textContent = `已保存 ${providerLabel(config.provider)} · ${config.model}`;
    llmConfigStatus.className = "config-status ok";
    updateLlmSummary(config);
  } catch (error) {
    llmConfigStatus.textContent = `保存失败：${error.message}`;
    llmConfigStatus.className = "config-status warn";
  } finally {
    llmSave.disabled = false;
    llmSave.textContent = "保存";
  }
}

function setLlmMenuOpen(open) {
  llmConfigForm.hidden = !open;
  llmConfigToggle.setAttribute("aria-expanded", open ? "true" : "false");
  llmMenu.classList.toggle("open", open);
}

function updateLlmSummary(config) {
  const configured = Boolean(config.api_key_configured);
  const provider = providerLabel(config.provider);
  llmConfigSummary.textContent = configured
    ? `${provider} · 已配置`
    : provider
      ? `${provider} · 未配置`
      : "模型未配置";
  llmConfigToggle.classList.toggle("configured", configured);
  llmConfigToggle.classList.toggle("unconfigured", !configured);
}

function applyProviderDefaults(provider, options = {}) {
  const defaults = llmDefaults[provider] || llmDefaults.deepseek;
  if (!options.onlyEmpty || !llmModel.value.trim()) {
    llmModel.value = defaults.model;
  }
  if (!options.onlyEmpty || !llmBaseUrl.value.trim()) {
    llmBaseUrl.value = defaults.base_url;
  }
}

function providerLabel(provider) {
  return {
    deepseek: "DeepSeek",
    aliyun: "阿里百炼",
    custom: "自定义模型",
  }[provider] || provider;
}

async function loadTasks() {
  const tasks = await api("/api/downloads");
  updateEmptyState(tasks.length);
  tasks.forEach((task) => {
    renderTask(task);
    if (task.status === "queued" || task.status === "running") {
      activeTasks.add(task.id);
      pollTask(task.id);
    }
  });
}

async function pollTask(id) {
  if (!activeTasks.has(id)) return;

  try {
    const task = await api(`/api/downloads/${id}`);
    renderTask(task);
    if (task.status === "completed" || task.status === "failed") {
      activeTasks.delete(id);
      return;
    }
  } catch (error) {
    console.error(error);
    if (error.status === 404) {
      activeTasks.delete(id);
      return;
    }
  }

  window.setTimeout(() => pollTask(id), 1000);
}

function renderTask(task) {
  let node = taskNodes.get(task.id);
  if (!node) {
    node = template.content.firstElementChild.cloneNode(true);
    taskNodes.set(task.id, node);
    tasksEl.prepend(node);
    updateEmptyState(taskNodes.size);
  }

  node.className = `task ${task.status}`;
  node.dataset.taskId = task.id;
  node.querySelector(".status").textContent = statusLabel(task.status);
  node.querySelector(".status").setAttribute("aria-label", `任务状态：${statusLabel(task.status)}`);
  node.querySelector(".task-url").textContent = task.url;
  const percent = task.progress?.percent;
  node.querySelector(".percent").textContent =
    typeof percent === "number" ? `${percent.toFixed(1)}%` : "";
  node.querySelector(".progress-bar").style.width =
    typeof percent === "number" ? `${Math.min(percent, 100)}%` : "8%";
  node.querySelector(".message").textContent =
    task.error || task.progress?.message || "";
  const logs = task.logs || [];
  node.querySelector(".logs").textContent = logs.join("\n");
  node.querySelector(".log-details summary").textContent = `日志${logs.length ? ` · ${logs.length}` : ""}`;
  renderPreview(node.querySelector(".preview"), task.result);
  renderLinks(node.querySelector(".result-links"), task.result);
}

function updateEmptyState(count) {
  emptyState.hidden = count > 0;
}

function renderPreview(target, result) {
  if (!result) {
    target.innerHTML = "";
    target.dataset.previewKey = "";
    return;
  }

  const metadata = result.metadata || {};
  const videoUrl = metadata.video?.pathUrl || result.outputPathUrl;
  const title = displayTitle(metadata);
  const previewKey = [
    videoUrl,
    title,
    metadata.desc,
    metadata.shareCaption,
    metadata.transcript?.textPathUrl || "",
    metadata.transcript?.content?.length || 0,
  ].join("|");

  if (target.dataset.previewKey === previewKey) {
    return;
  }

  target.dataset.previewKey = previewKey;
  target.innerHTML = "";

  const shell = document.createElement("section");
  shell.className = "media-preview";

  const media = document.createElement("div");
  media.className = "media-box";
  if (videoUrl) {
    const video = document.createElement("video");
    video.src = videoUrl;
    video.controls = true;
    video.preload = "metadata";
    video.setAttribute("aria-label", title ? `播放视频：${title}` : "播放视频");
    media.append(video);
  }

  const info = document.createElement("div");
  info.className = "media-info";
  info.append(textBlock("标题", title || "未解析到标题", "title-text"));
  const captionText = metadata.desc || metadata.shareCaption || "";
  info.append(
    captionText
      ? rewriteTextBlock("文案", captionText, "caption")
      : textBlock("文案", "未解析到文案")
  );

  const transcript = metadata.transcript;
  if (transcript?.content || transcript?.text) {
    const details = document.createElement("details");
    details.className = "transcript";
    details.open = true;
    const summary = document.createElement("summary");
    summary.textContent = "声音对话";
    const pre = document.createElement("pre");
    const transcriptText = transcript.content || transcript.text;
    pre.textContent = transcriptText;
    details.append(summary, pre, renderRewriteTool(transcriptText, "transcript"));
    info.append(details);
  } else if (videoUrl) {
    const button = document.createElement("button");
    button.className = "secondary transcribe-button";
    button.type = "button";
    button.textContent = "提取声音对话";
    button.addEventListener("click", () => startTranscription(target.closest(".task")?.dataset.taskId));
    info.append(labelWrap("声音对话", button));
  }

  shell.append(media, info);
  target.append(shell);
}

function renderLinks(target, result) {
  target.innerHTML = "";
  if (!result) return;

  const links = [
    ["下载视频", result.outputPathUrl],
    ["查看元数据", result.metadataPathUrl],
    ["下载对话文本", result.metadata?.transcript?.textPathUrl],
  ].filter(([, url]) => url);

  links.forEach(([label, url]) => {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.target = "_blank";
    anchor.rel = "noreferrer";
    anchor.textContent = label;
    target.append(anchor);
  });
}

async function startTranscription(taskId) {
  if (!taskId) return;
  try {
    const node = taskNodes.get(taskId);
    const button = node?.querySelector(".transcribe-button");
    if (button) {
      button.disabled = true;
      button.textContent = "提取中...";
    }
    const task = await api(`/api/downloads/${taskId}/transcribe`, { method: "POST" });
    renderTask(task);
    activeTasks.add(task.id);
    pollTask(task.id);
  } catch (error) {
    alert(error.message);
  }
}

function rewriteTextBlock(labelText, value, source) {
  const block = textBlock(labelText, value);
  block.append(renderRewriteTool(value, source));
  return block;
}

function renderRewriteTool(text, source) {
  const wrap = document.createElement("div");
  wrap.className = "rewrite-tool";

  const actions = document.createElement("div");
  actions.className = "rewrite-actions";

  const styleSelect = document.createElement("select");
  styleSelect.className = "rewrite-style";
  styleSelect.setAttribute("aria-label", "改写风格");
  [
    ["social", "社媒文案"],
    ["summary", "简洁摘要"],
    ["polished", "正式润色"],
  ].forEach(([value, label]) => {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    styleSelect.append(option);
  });

  const button = document.createElement("button");
  button.type = "button";
  button.className = "secondary rewrite-button";
  button.textContent = "AI 改写";

  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "secondary rewrite-copy";
  copy.textContent = "复制";
  copy.hidden = true;

  const result = document.createElement("pre");
  result.className = "rewrite-result";
  result.hidden = true;

  button.addEventListener("click", async () => {
    await rewriteSourceText({
      text,
      source,
      style: styleSelect.value,
      button,
      result,
      copy,
    });
  });
  copy.addEventListener("click", async () => {
    await copyText(result.textContent, copy);
  });

  actions.append(styleSelect, button, copy);
  wrap.append(actions, result);
  return wrap;
}

async function rewriteSourceText({ text, source, style, button, result, copy }) {
  button.disabled = true;
  button.textContent = "改写中...";
  result.hidden = false;
  result.textContent = "正在生成改写结果...";
  copy.hidden = true;

  try {
    const response = await api("/api/ai/rewrite", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, source, style }),
    });
    result.textContent = response.text;
    copy.hidden = false;
  } catch (error) {
    result.textContent = `改写失败：${error.message}`;
  } finally {
    button.disabled = false;
    button.textContent = "AI 改写";
  }
}

async function copyText(text, button) {
  try {
    await navigator.clipboard.writeText(text || "");
    button.textContent = "已复制";
    window.setTimeout(() => {
      button.textContent = "复制";
    }, 1400);
  } catch {
    alert("复制失败，请手动选择文本复制。");
  }
}

function textBlock(labelText, value, extraClass = "") {
  const block = document.createElement("div");
  block.className = `field ${extraClass}`.trim();
  const label = document.createElement("span");
  label.className = "field-label";
  label.textContent = labelText;
  const text = document.createElement("p");
  text.textContent = value;
  block.append(label, text);
  return block;
}

function labelWrap(labelText, child) {
  const block = document.createElement("div");
  block.className = "field";
  const label = document.createElement("span");
  label.className = "field-label";
  label.textContent = labelText;
  block.append(label, child);
  return block;
}

function displayTitle(metadata) {
  if (
    metadata.platform === "kuaishou" &&
    metadata.shareCaption &&
    (!metadata.title || metadata.title.length < 10 || metadata.title === "更多精彩视频等你来看")
  ) {
    return metadata.shareCaption;
  }

  return metadata.title;
}

function statusLabel(status) {
  return {
    queued: "排队中",
    running: "下载中",
    completed: "已完成",
    failed: "失败",
  }[status] || status;
}

async function api(url, options) {
  const response = await fetch(url, options);
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(data?.detail || `请求失败: ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return data;
}
