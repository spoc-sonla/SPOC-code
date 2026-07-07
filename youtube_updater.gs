const YT_WEBHOOK_URL = "https://discord.com/api/webhooks/...";
const YT_PROP_PREFIX = "YT_SNAP_";
const YT_INIT_FLAG = "YT_SNAP_INITIALIZED";
const YT_CHANNEL_KEY = "YT_CHANNEL_SNAPSHOT";

const PRIVACY_LABEL = {
  public: "🌐 Công khai",
  unlisted: "🔗 Không công khai (unlisted)",
  private: "🔒 Riêng tư"
};

/* ================= HÀM DÙNG CHUNG ================= */
function getUploadsPlaylistId() {
  const res = YouTube.Channels.list('contentDetails', { mine: true });
  return res.items[0].contentDetails.relatedPlaylists.uploads;
}

function getAllVideoIds(playlistId) {
  let ids = [];
  let pageToken;
  do {
    const res = YouTube.PlaylistItems.list('contentDetails', {
      playlistId: playlistId, maxResults: 50, pageToken: pageToken
    });
    res.items.forEach(item => ids.push(item.contentDetails.videoId));
    pageToken = res.nextPageToken;
  } while (pageToken);
  return ids;
}

function getVideosData(ids) {
  const map = {};
  for (let i = 0; i < ids.length; i += 50) {
    const batch = ids.slice(i, i + 50);
    if (batch.length === 0) continue;
    const res = YouTube.Videos.list('snippet,status', { id: batch.join(',') });
    res.items.forEach(v => {
      map[v.id] = {
        title: v.snippet.title,
        description: v.snippet.description || "",
        privacyStatus: v.status.privacyStatus,
        url: "https://www.youtube.com/watch?v=" + v.id
      };
    });
  }
  return map;
}

function formatText(text) {
  if (!text) return "(trống)";
  const safe = text.replace(/`/g, "'");
  return "```\n" + safe + "\n```";
}

function saveChunked(prefix, obj) {
  const props = PropertiesService.getScriptProperties();
  const all = props.getProperties();
  for (const key in all) {
    if (key.indexOf(prefix) === 0) props.deleteProperty(key);
  }

  const json = JSON.stringify(obj);
  const chunkSize = 8000;
  const chunks = [];
  for (let i = 0; i < json.length; i += chunkSize) {
    chunks.push(json.substring(i, i + chunkSize));
  }

  const toSet = {};
  chunks.forEach((c, i) => toSet[prefix + i] = c);
  toSet[prefix + "COUNT"] = String(chunks.length);
  props.setProperties(toSet, false);
}

function loadChunked(prefix) {
  const props = PropertiesService.getScriptProperties();
  const countStr = props.getProperty(prefix + "COUNT");
  if (!countStr) return {};

  const count = Number(countStr);
  let json = "";
  for (let i = 0; i < count; i++) {
    json += props.getProperty(prefix + i) || "";
  }

  try {
    return JSON.parse(json);
  } catch (e) {
    return {};
  }
}

/* ================= GỬI DISCORD (VIDEO) ================= */
function sendYtDiscord(type, oldItem, newItem, changes) {
  const CONFIG = {
    new_video:     { title: "🎬 Video mới",         color: 3066993 },
    deleted_video: { title: "🗑️ Video bị xóa",      color: 15158332 },
    changed:       { title: "✏️ Video có thay đổi", color: 15844367 }
  };

  const cfg = CONFIG[type];
  const fields = [];
  changes = changes || [];

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
  } else if (newItem.privacyStatus) {
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

  UrlFetchApp.fetch(YT_WEBHOOK_URL, {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify({ embeds: [{ title: cfg.title, color: cfg.color, fields: fields }] })
  });
}

/* ================= 1. KIỂM TRA VIDEO ================= */
function checkYoutube() {
  const playlistId = getUploadsPlaylistId();
  const ids = getAllVideoIds(playlistId);
  const current = getVideosData(ids);

  const props = PropertiesService.getScriptProperties();
  const isFirstRun = props.getProperty(YT_INIT_FLAG) !== "1";

  if (isFirstRun) {
    saveChunked(YT_PROP_PREFIX, current);
    props.setProperty(YT_INIT_FLAG, "1");
    return;
  }

  const previous = loadChunked(YT_PROP_PREFIX);

  for (const id in current) {
    const now = current[id];
    const old = previous[id];

    if (!old) {
      sendYtDiscord("new_video", now, now);
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

  saveChunked(YT_PROP_PREFIX, current);
}

/* ================= 2. KIỂM TRA THAY ĐỔI CẤP KÊNH ================= */
function getChannelData() {
  const res = YouTube.Channels.list('snippet,statistics', { mine: true });
  const c = res.items[0];
  return {
    title: c.snippet.title,
    description: c.snippet.description || "",
    thumbnail: c.snippet.thumbnails.default.url,
    subscriberCount: c.statistics.hiddenSubscriberCount ? "Ẩn" : c.statistics.subscriberCount
  };
}

function checkYoutubeChannel() {
  const current = getChannelData();
  const props = PropertiesService.getScriptProperties();
  const oldJson = props.getProperty(YT_CHANNEL_KEY);

  if (!oldJson) {
    props.setProperty(YT_CHANNEL_KEY, JSON.stringify(current));
    return;
  }

  const old = JSON.parse(oldJson);
  const fields = [];

  if (old.title !== current.title) {
    fields.push({ name: "Tên kênh", value: old.title + " → " + current.title, inline: false });
  }
  if (old.description !== current.description) {
    fields.push({ name: "Mô tả kênh cũ", value: formatText(old.description), inline: false });
    fields.push({ name: "Mô tả kênh mới", value: formatText(current.description), inline: false });
  }
  if (old.thumbnail !== current.thumbnail) {
    fields.push({ name: "Ảnh đại diện", value: "Đã thay đổi", inline: false });
  }

  if (fields.length > 0) {
    fields.push({ name: "Thời gian", value: new Date().toLocaleString("vi-VN"), inline: true });
    UrlFetchApp.fetch(YT_WEBHOOK_URL, {
      method: "post",
      contentType: "application/json",
      payload: JSON.stringify({
        embeds: [{ title: "📺 Kênh có thay đổi", color: 15105570, fields: fields }]
      })
    });
  }

  props.setProperty(YT_CHANNEL_KEY, JSON.stringify(current));
}
