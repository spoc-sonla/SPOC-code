const WEBHOOK_URL = "https://discord.com/api/webhooks/...";
const FOLDER_ID = "1A5gyIKW9YOeYq8F11Pil1OBt55Lq8N5c";
const ROOT_ID = FOLDER_ID;
const ROOT_NAME = "SPOC";
const PROP_PREFIX = "SNAP_";
const TOKEN_PROP = "DRIVE_PAGE_TOKEN";

function emergencyReset() {
  PropertiesService.getScriptProperties().deleteProperty(TOKEN_PROP);
  initDriveSnapshot(); // rebuild lại toàn bộ cây + lấy token mới nhất
  Logger.log("Đã reset xong, số item: " + Object.keys(loadSnapshot()).length);
}

/* ================= THU THẬP TOÀN BỘ CÂY THƯ MỤC (dùng khi khởi tạo) ================= */
function collectAll(folder, path, parentId, map) {
  map[folder.getId()] = {
    name: folder.getName(),
    path: path,
    parentId: parentId,
    isFolder: true,
    lastUpdated: folder.getLastUpdated().getTime(),
    url: folder.getUrl()
  };

  const files = folder.getFiles();
  while (files.hasNext()) {
    const f = files.next();
    map[f.getId()] = {
      name: f.getName(),
      path: path,
      parentId: folder.getId(),
      isFolder: false,
      lastUpdated: f.getLastUpdated().getTime(),
      url: f.getUrl()
    };
  }

  const folders = folder.getFolders();
  while (folders.hasNext()) {
    const sub = folders.next();
    const newPath = path + "/" + sub.getName();
    collectAll(sub, newPath, folder.getId(), map);
  }
}

/* ================= LƯU / ĐỌC SNAPSHOT (chia chunk vì mỗi property tối đa ~9KB) ================= */
function saveSnapshot(map) {
  const props = PropertiesService.getScriptProperties();
  const keys = Object.keys(map);

  // Safeguard: không cho ghi snapshot rỗng nếu trước đó có dữ liệu, tránh mất toàn bộ cây theo dõi
  if (keys.length === 0) {
    const countStr = props.getProperty(PROP_PREFIX + "COUNT");
    if (countStr && Number(countStr) > 0) {
      throw new Error("saveSnapshot: từ chối ghi đè snapshot rỗng lên snapshot đang có dữ liệu");
    }
  }

  const all = props.getProperties();
  for (const key in all) {
    if (key.indexOf(PROP_PREFIX) === 0) props.deleteProperty(key);
  }

  const json = JSON.stringify(map);
  const chunkSize = 8000;
  const chunks = [];
  for (let i = 0; i < json.length; i += chunkSize) {
    chunks.push(json.substring(i, i + chunkSize));
  }

  const toSet = {};
  chunks.forEach((c, i) => toSet[PROP_PREFIX + i] = c);
  toSet[PROP_PREFIX + "COUNT"] = String(chunks.length);
  props.setProperties(toSet, false);
}

function loadSnapshot() {
  const props = PropertiesService.getScriptProperties();
  const countStr = props.getProperty(PROP_PREFIX + "COUNT");
  if (!countStr) return {};

  const count = Number(countStr);
  let json = "";
  for (let i = 0; i < count; i++) {
    json += props.getProperty(PROP_PREFIX + i) || "";
  }

  try {
    return JSON.parse(json);
  } catch (e) {
    return {};
  }
}

/* ================= KHỞI TẠO (chạy 1 lần đầu tiên, hoặc khi cần reset) ================= */
function initDriveSnapshot() {
  const rootFolder = DriveApp.getFolderById(FOLDER_ID);
  const current = {};
  collectAll(rootFolder, ROOT_NAME, null, current);
  saveSnapshot(current);

  const tokenRes = Drive.Changes.getStartPageToken();
  PropertiesService.getScriptProperties().setProperty(TOKEN_PROP, tokenRes.startPageToken);
}

/* ================= KIỂM TRA XEM 1 FILE/FOLDER CÓ NẰM TRONG CÂY ĐANG THEO DÕI KHÔNG =================
   Nếu có mà chưa từng thấy -> tự đăng ký (dùng khi phát hiện item MỚI) */
function ensureInTree(fileId, snapshot, newlyAdded) {
  if (fileId === ROOT_ID) return snapshot[ROOT_ID] || null;
  if (snapshot[fileId]) return snapshot[fileId];

  let meta;
  try {
    meta = Drive.Files.get(fileId, { fields: "id,name,mimeType,modifiedTime,parents,trashed,webViewLink" });
  } catch (e) {
    return null;
  }

  if (meta.trashed) return null;
  if (!meta.parents || meta.parents.length === 0) return null;

  const parentEntry = ensureInTree(meta.parents[0], snapshot, newlyAdded);
  if (!parentEntry) return null;

  const isFolder = meta.mimeType === "application/vnd.google-apps.folder";
  const entry = {
    name: meta.name,
    path: isFolder ? (parentEntry.path + "/" + meta.name) : parentEntry.path,
    parentId: meta.parents[0],
    isFolder: isFolder,
    lastUpdated: new Date(meta.modifiedTime).getTime(),
    url: meta.webViewLink || ("https://drive.google.com/open?id=" + fileId)
  };

  snapshot[fileId] = entry;
  newlyAdded.push(fileId);
  return entry;
}

/* ================= LẤY "VỊ TRÍ" (full path) ỨNG VỚI 1 parentId ================= */
function getParentEntry(snapshot, parentId) {
  if (parentId === ROOT_ID) return snapshot[ROOT_ID] || null;
  if (snapshot[parentId] && snapshot[parentId].isFolder) return snapshot[parentId];
  return null;
}

/* Cập nhật path cho toàn bộ item nằm bên trong 1 thư mục vừa bị move */
function updateDescendantPaths(snapshot, oldFullPath, newFullPath) {
  for (const id in snapshot) {
    const e = snapshot[id];
    if (e.path === oldFullPath || e.path.indexOf(oldFullPath + "/") === 0) {
      e.path = newFullPath + e.path.substring(oldFullPath.length);
    }
  }
}

/* ================= HÀM CHÍNH — gắn vào trigger, chạy mỗi 1–5 phút ================= */
function checkDriveFast() {
  const lock = LockService.getScriptLock();
  const gotLock = lock.tryLock(10000);
  if (!gotLock) {
    Logger.log("checkDriveFast: đang có lần chạy khác, bỏ qua lần này");
    return;
  }

  try {
    checkDriveFast_();
  } finally {
    lock.releaseLock();
  }
}

function checkDriveFast_() {
  const props = PropertiesService.getScriptProperties();
  let pageToken = props.getProperty(TOKEN_PROP);

  if (!pageToken) {
    initDriveSnapshot();
    return;
  }

  const snapshot = loadSnapshot();
  const newlyAdded = [];
  const pendingNotifications = []; // <-- gom lại thay vì gửi ngay
  let response;

  do {
    response = Drive.Changes.list(pageToken, {
      fields: "nextPageToken,newStartPageToken,changes(fileId,removed,file(id,name,mimeType,modifiedTime,trashed,parents,webViewLink))",
      pageSize: 100,
      includeRemoved: true
    });

    for (const change of (response.changes || [])) {
      const fileId = change.fileId;
      if (fileId === ROOT_ID) continue;

      const wasTracked = !!snapshot[fileId];

      if (change.removed || (change.file && change.file.trashed)) {
        if (wasTracked) {
          const old = snapshot[fileId];
          pendingNotifications.push(buildNotification(old.isFolder ? "deleted_folder" : "deleted_file", old, old));
          delete snapshot[fileId];
        }
        continue;
      }

      if (!change.file) continue;
      const meta = change.file;

      if (!wasTracked) {
        const entry = ensureInTree(fileId, snapshot, newlyAdded);
        if (entry) {
          pendingNotifications.push(buildNotification(entry.isFolder ? "new_folder" : "new_file", entry, entry));
        }
        continue;
      }

      const old = snapshot[fileId];
      const newModified = new Date(meta.modifiedTime).getTime();
      const newParentId = meta.parents ? meta.parents[0] : old.parentId;

      const renamed = old.name !== meta.name;
      const updated = !old.isFolder && old.lastUpdated !== newModified;
      const moved = newParentId !== old.parentId;

      let newLocationPath = old.path;

      if (moved) {
        const newParentEntry = getParentEntry(snapshot, newParentId);

        if (!newParentEntry) {
          pendingNotifications.push(buildNotification(old.isFolder ? "deleted_folder" : "deleted_file", old, old));
          delete snapshot[fileId];
          continue;
        }

        const oldFullPath = old.isFolder ? old.path : (old.path + "/" + old.name);
        let newFullPath;

        if (old.isFolder) {
          newFullPath = newParentEntry.path + "/" + meta.name;
          updateDescendantPaths(snapshot, old.path, newFullPath);
          newLocationPath = newFullPath;
        } else {
          newFullPath = newParentEntry.path + "/" + meta.name;
          newLocationPath = newParentEntry.path;
        }

        pendingNotifications.push(buildNotification(
          "moved",
          old,
          { name: meta.name, path: newLocationPath, parentId: newParentId, isFolder: old.isFolder, lastUpdated: newModified, url: old.url },
          null,
          oldFullPath,
          newFullPath
        ));
      }

      const finalEntry = {
        name: meta.name,
        path: newLocationPath,
        parentId: newParentId,
        isFolder: old.isFolder,
        lastUpdated: newModified,
        url: old.url
      };

      if (renamed && updated) {
        pendingNotifications.push(buildNotification("renamed_and_updated", old, finalEntry));
      } else if (renamed) {
        pendingNotifications.push(buildNotification("renamed", old, finalEntry));
      } else if (updated) {
        pendingNotifications.push(buildNotification("updated", old, finalEntry));
      }

      snapshot[fileId] = finalEntry;
    }

    pageToken = response.nextPageToken;
  } while (pageToken);

  saveSnapshot(snapshot);
  props.setProperty(TOKEN_PROP, response.newStartPageToken);

  Logger.log("Số thông báo cần gửi: " + pendingNotifications.length);
  sendBatchedDiscord(pendingNotifications);
}

/* ================= FORMAT TÊN FILE ================= */
function formatFileName(text) {
  if (!text) return "(trống)";
  const safe = text.replace(/`/g, "'");
  return "`" + safe + "`";
}

/* ================= XÂY DỰNG 1 "MỤC THÔNG BÁO" (chưa gửi, chỉ build data) ================= */
function buildNotification(type, oldItem, newItem, modifiedBy, fromPath, toPath) {
  const CONFIG = {
    new_file:            { emoji: "📄", label: "File mới",             color: 3066993 },
    new_folder:          { emoji: "📁", label: "Thư mục mới",          color: 3066993 },
    deleted_file:        { emoji: "🗑️", label: "File bị xóa",          color: 15158332 },
    deleted_folder:      { emoji: "🗑️", label: "Thư mục bị xóa",       color: 15158332 },
    renamed:             { emoji: "✏️", label: "Đổi tên",              color: 15844367 },
    updated:             { emoji: "🔄", label: "Cập nhật nội dung",     color: 5793266 },
    renamed_and_updated: { emoji: "✏️🔄", label: "Đổi tên & cập nhật",  color: 15105570 },
    moved:               { emoji: "📦", label: "Đã di chuyển",          color: 3447003 }
  };

  const cfg = CONFIG[type] || { emoji: "🔔", label: "Thay đổi", color: 5763719 };

  let line;
  if (type === "renamed" || type === "renamed_and_updated") {
    line = `${cfg.emoji} **${cfg.label}**\n`
         + `Tên: ${formatFileName(oldItem.name)}\n`
         + `**⟶** ${formatFileName(newItem.name)}\n`
         + `📍 ${formatFileName(newItem.path)}`;
  } else if (type === "moved") {
    line = `${cfg.emoji} **${cfg.label}**\n`
         + `Tên: ${formatFileName(newItem.name)}\n`
         + `${formatFileName(fromPath)}\n`
         + `**⟶→** ${formatFileName(toPath)}`;
  } else {
    line = `${cfg.emoji} **${cfg.label}**\n`
         + `Tên: ${formatFileName(newItem.name)}\n`
         + `📂 ${formatFileName(newItem.path)}`;
  }

  if (type !== "deleted_file" && type !== "deleted_folder" && newItem.url) {
    line += `\n🔗 [Mở](${newItem.url})`;
  }

  return { type: type, color: cfg.color, text: line };
}

/* ================= GỬI GỘP NHIỀU THÔNG BÁO THÀNH ÍT EMBED / REQUEST NHẤT ================= */
function sendBatchedDiscord(notifications) {
  if (!notifications || notifications.length === 0) return;

  const now = new Date().toLocaleString("vi-VN");
  const MAX_DESC_LENGTH = 3800;
  const MAX_EMBEDS_PER_MESSAGE = 10;

  // Gộp các dòng lại, cắt thành nhiều embed nếu tổng ký tự vượt giới hạn
  const embeds = [];
  let currentLines = [];
  let currentLength = 0;
  let currentColor = notifications[0].color;

  function flushEmbed() {
    if (currentLines.length === 0) return;
    embeds.push({
      title: `🔔 Cập nhật Drive (${currentLines.length} thay đổi)`,
      description: currentLines.join("\n\n"),
      color: currentColor,
      footer: { text: now }
    });
    currentLines = [];
    currentLength = 0;
  }

  for (const n of notifications) {
    const addedLength = n.text.length + 2;
    if (currentLength + addedLength > MAX_DESC_LENGTH) {
      flushEmbed();
    }
    currentLines.push(n.text);
    currentLength += addedLength;
  }
  flushEmbed();

  // Gửi theo lô, mỗi request tối đa MAX_EMBEDS_PER_MESSAGE embed
  for (let i = 0; i < embeds.length; i += MAX_EMBEDS_PER_MESSAGE) {
    const chunk = embeds.slice(i, i + MAX_EMBEDS_PER_MESSAGE);
    postToDiscordWithRetry({ embeds: chunk });
  }
}

/* ================= GỬI 1 REQUEST TỚI DISCORD, TỰ RETRY NẾU BỊ RATE-LIMIT ================= */
function postToDiscordWithRetry(payload) {
  const maxRetries = 3;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const res = UrlFetchApp.fetch(WEBHOOK_URL, {
      method: "post",
      contentType: "application/json",
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });

    const code = res.getResponseCode();

    if (code >= 200 && code < 300) return;

    if (code === 429 && attempt < maxRetries) {
      let retryAfterMs = 1000 * (attempt + 1);
      try {
        const body = JSON.parse(res.getContentText());
        if (body.retry_after) retryAfterMs = Math.ceil(body.retry_after * 1000) + 200;
      } catch (e) {}
      Utilities.sleep(retryAfterMs);
      continue;
    }

    Logger.log("postToDiscordWithRetry thất bại (code " + code + "): " + res.getContentText().substring(0, 300));
    return;
  }

  // Delay nhẹ giữa các request khi có nhiều lô
  Utilities.sleep(350);
}
