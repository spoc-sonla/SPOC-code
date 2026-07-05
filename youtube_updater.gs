const YT_WEBHOOK_URL = "https://discord.com/api/webhooks/...";
const YT_PROP_PREFIX = "YT_SNAP_";
const YT_INIT_FLAG = "YT_SNAP_INITIALIZED";

/* ---------- Lấy ID playlist "Uploads" của kênh ---------- */
function getUploadsPlaylistId() {
  const res = YouTube.Channels.list('contentDetails', { mine: true });
  return res.items[0].contentDetails.relatedPlaylists.uploads;
}

/* ---------- Lấy toàn bộ videoId trong playlist (có phân trang) ---------- */
function getAllVideoIds(playlistId) {
  let ids = [];
  let pageToken = undefined;

  do {
    const res = YouTube.PlaylistItems.list('contentDetails', {
      playlistId: playlistId,
      maxResults: 50,
      pageToken: pageToken
    });
    res.items.forEach(item => ids.push(item.contentDetails.videoId));
    pageToken = res.nextPageToken;
  } while (pageToken);

  return ids;
}

/* ---------- Lấy chi tiết từng video (title, mô tả, trạng thái riêng tư) ---------- */
function getVideosData(ids) {
  const map = {};

  for (let i = 0; i < ids.length; i += 50) {
    const batch = ids.slice(i, i + 50);
    const res = YouTube.Videos.list('snippet,status', { id: batch.join(',') });

    res.items.forEach(v => {
      map[v.id] = {
        title: v.snippet.title,
        description: v.snippet.description || "",
        privacyStatus: v.status.privacyStatus, // public / unlisted / private
        url: "https://www.youtube.com/watch?v=" + v.id
      };
    });
  }

  return map;
}

/* ---------- Lưu / đọc snapshot (chia chunk giống bản Drive) ---------- */
function saveYtSnapshot(map) {
  const props = PropertiesService.getScriptProperties();
  const all = props.getProperties();
  for (const key in all) {
    if (key.indexOf(YT_PROP_PREFIX) === 0) props.deleteProperty(key);
  }

  const json = JSON.stringify(map);
  const chunkSize = 8000;
  const chunks = [];
  for (let i = 0; i < json.length; i += chunkSize) {
    chunks.push(json.substring(i, i + chunkSize));
  }

  const toSet = {};
  chunks.forEach((c, i) => toSet[YT_PROP_PREFIX + i] = c);
  toSet[YT_PROP_PREFIX + "COUNT"] = String(chunks.length);
  props.setProperties(toSet, false);
  props.setProperty(YT_INIT_FLAG, "1");
}

function loadYtSnapshot() {
  const props = PropertiesService.getScriptProperties();
  const countStr = props.getProperty(YT_PROP_PREFIX + "COUNT");
  if (!countStr) return {};

  const count = Number(countStr);
  let json = "";
  for (let i = 0; i < count; i++) {
    json += props.getProperty(YT_PROP_PREFIX + i) || "";
  }

  try {
    return JSON.parse(json);
  } catch (e) {
    return {};
  }
}

/* ---------- Hàm chính ---------- */
function checkYoutube() {
  const playlistId = getUploadsPlaylistId();
  const ids = getAllVideoIds(playlistId);
  const current = getVideosData(ids);

  const props = PropertiesService.getScriptProperties();
  const isFirstRun = props.getProperty(YT_INIT_FLAG) !== "1";

  if (isFirstRun) {
    saveYtSnapshot(current);
    return;
  }

  const previous = loadYtSnapshot();

  for (const id in current) {
    const now = current[id];
    const old = previous[id];

    if (!old) {
      sendYtDiscord("new_video", old, now);
      continue;
    }

    const changes = [];
    if (old.title !== now.title) changes.push("title");
    if (old.description !== now.description) changes.push("description");
    if (old.privacyStatus !== now.privacyStatus) changes.push("privacy");

    if (changes.length > 0) {
      sendYtDiscord("changed", old, now, changes);
    }
  }

  for (const id in previous) {
    if (!current[id]) {
      sendYtDiscord("deleted_video", previous[id], previous[id]);
    }
  }

  saveYtSnapshot(current);
}

/* ---------- Gửi Discord ---------- */
function formatText(text) {
  if (!text) return "(trống)";
  const safe = text.replace(/`/g, "'");
  const trimmed = safe.length > 900 ? safe.substring(0, 900) + "..." : safe;
  return "```\n" + trimmed + "\n```";
}

const PRIVACY_LABEL = {
  public: "🌐 Công khai",
  unlisted: "🔗 Không công khai (unlisted)",
  private: "🔒 Riêng tư"
};

function sendYtDiscord(type, oldItem, newItem, changes) {
  const CONFIG = {
    new_video:     { title: "🎬 Video mới",     color: 3066993 },
    deleted_video: { title: "🗑️ Video bị xóa",  color: 15158332 },
    changed:       { title: "✏️ Video có thay đổi", color: 15844367 }
  };

  const cfg = CONFIG[type];
  const fields = [];

  if (type === "changed" && changes.includes("title")) {
    fields.push({ name: "Tiêu đề cũ", value: formatText(oldItem.title), inline: false });
    fields.push({ name: "Tiêu đề mới", value: formatText(newItem.title), inline: false });
  } else {
    fields.push({ name: "Tiêu đề", value: formatText(newItem.title), inline: false });
  }

  if (type === "changed" && changes.includes("description")) {
    fields.push({ name: "Mô tả cũ", value: formatText(oldItem.description), inline: false });
    fields.push({ name: "Mô tả mới", value: formatText(newItem.description), inline: false });
  }

  if (type === "changed" && changes.includes("privacy")) {
    fields.push({
      name: "Chế độ hiển thị",
      value: (PRIVACY_LABEL[oldItem.privacyStatus] || oldItem.privacyStatus) +
             " → " + (PRIVACY_LABEL[newItem.privacyStatus] || newItem.privacyStatus),
      inline: false
    });
  } else {
    fields.push({
      name: "Chế độ hiển thị",
      value: PRIVACY_LABEL[newItem.privacyStatus] || newItem.privacyStatus,
      inline: true
    });
  }

  fields.push({ name: "Thời gian", value: new Date().toLocaleString("vi-VN"), inline: true });

  if (type !== "deleted_video") {
    fields.push({ name: "Liên kết", value: newItem.url, inline: false });
  }

  const data = {
    embeds: [{
      title: cfg.title,
      color: cfg.color,
      fields: fields
    }]
  };

  UrlFetchApp.fetch(YT_WEBHOOK_URL, {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify(data)
  });
}
