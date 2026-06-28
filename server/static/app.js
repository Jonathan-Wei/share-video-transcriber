const form = document.querySelector("#download-form");
const submit = document.querySelector("#submit");
const tasksEl = document.querySelector("#tasks");
const template = document.querySelector("#task-template");
const formError = document.querySelector("#form-error");
const asrStatus = document.querySelector("#asr-status");
const emptyState = document.querySelector("#empty-state");
const taskNodes = new Map();
const activeTasks = new Set();

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

loadAsrStatus();
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
  const coverUrl = metadata.cover?.pathUrl || "";
  const title = displayTitle(metadata);
  const previewKey = [
    videoUrl,
    coverUrl,
    title,
    metadata.desc,
    metadata.shareCaption,
    metadata.subtitles?.length || 0,
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
    if (coverUrl) video.poster = coverUrl;
    video.setAttribute("aria-label", title ? `播放视频：${title}` : "播放视频");
    media.append(video);
  } else if (coverUrl) {
    const image = document.createElement("img");
    image.src = coverUrl;
    image.alt = metadata.title || "视频封面";
    media.append(image);
  }

  const info = document.createElement("div");
  info.className = "media-info";
  info.append(textBlock("标题", title || "未解析到标题", "title-text"));
  info.append(textBlock("文案", metadata.desc || metadata.shareCaption || "未解析到文案"));

  if (coverUrl) {
    const cover = document.createElement("img");
    cover.className = "cover-thumb";
    cover.src = coverUrl;
    cover.alt = "封面";
    info.append(labelWrap("封面", cover));
  }

  const subtitles = metadata.subtitles || [];
  if (subtitles.length > 0) {
    const subtitleWrap = document.createElement("div");
    subtitleWrap.className = "subtitle-list";
    const label = document.createElement("span");
    label.className = "field-label";
    label.textContent = "字幕";
    subtitleWrap.append(label);

    subtitles.forEach((subtitle, index) => {
      const details = document.createElement("details");
      details.className = "subtitle";
      if (index === 0) details.open = true;
      const summary = document.createElement("summary");
      summary.textContent = subtitle.language || subtitle.format || `字幕 ${index + 1}`;
      const pre = document.createElement("pre");
      pre.textContent = subtitle.content || "字幕文件已保存，但无法预览文本内容。";
      details.append(summary, pre);
      subtitleWrap.append(details);
    });
    info.append(subtitleWrap);
  } else {
    info.append(textBlock("字幕", "未解析到字幕内容"));
  }

  const transcript = metadata.transcript;
  if (transcript?.content || transcript?.text) {
    const details = document.createElement("details");
    details.className = "transcript";
    details.open = true;
    const summary = document.createElement("summary");
    summary.textContent = "声音对话";
    const pre = document.createElement("pre");
    pre.textContent = transcript.content || transcript.text;
    details.append(summary, pre);
    info.append(details);
  } else if (videoUrl) {
    const button = document.createElement("button");
    button.className = "secondary";
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
    const button = node?.querySelector(".secondary");
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
