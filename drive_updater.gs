const WEBHOOK_URL = "https://discord.com/api/webhooks/...";
const FOLDER_ID = "1A5gyIKW9YOeYq8F11Pil1OBt55Lq8N5c";
const ROOT_ID = FOLDER_ID;
const ROOT_NAME = "SPOC";
const TOKEN_PROP = "DRIVE_PAGE_TOKEN";
const SNAPSHOT_FILENAME = "_drive_monitor_snapshot.json";
const SNAPSHOT_FILE_ID_PROP = "SNAPSHOT_FILE_ID";

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
    let md5 = null;
    let headRevisionId = null;
    try {
      const meta = Drive.Files.get(f.getId(), { fields: "md5Checksum,headRevisionId" });
      md5 = meta.md5Checksum || null;
      headRevisionId = meta.headRevisionId || null;
    } catch (e) {}
    map[f.getId()] = {
      name: f.getName(),
      path: path,
      parentId: folder.getId(),
      isFolder: false,
      lastUpdated: f.getLastUpdated().getTime(),
      url: f.getUrl(),
      md5: md5,
      headRevisionId: headRevisionId
    };
  }

  const folders = folder.getFolders();
  while (folders.hasNext()) {
    const sub = folders.next();
    const newPath = path + "/" + sub.getName();
    collectAll(sub, newPath, folder.getId(), map);
  }
}

/* ================= LƯU / ĐỌC SNAPSHOT (lưu dưới dạng 1 file JSON trên Drive) ================= */

// Lấy (hoặc tạo mới nếu chưa có) file snapshot, trả về đối tượng File
function getOrCreateSnapshotFile() {
  const props = PropertiesService.getScriptProperties();
  const cachedId = props.getProperty(SNAPSHOT_FILE_ID_PROP);

  if (cachedId) {
    try {
      const f = DriveApp.getFileById(cachedId);
      if (!f.isTrashed()) return f;
    } catch (e) {
      // file id cũ không còn hợp lệ (đã bị xóa thủ công...), tạo lại bên dưới
    }
  }

  // Tìm theo tên trong thư mục gốc trước khi tạo mới
  const rootFolder = DriveApp.getFolderById(FOLDER_ID);
  const it = DriveApp.getFilesByName(SNAPSHOT_FILENAME);
  while (it.hasNext()) {
    const f = it.next();
    props.setProperty(SNAPSHOT_FILE_ID_PROP, f.getId());
    return f;
  }

  const newFile = DriveApp.createFile(SNAPSHOT_FILENAME, "{}", MimeType.PLAIN_TEXT);
  props.setProperty(SNAPSHOT_FILE_ID_PROP, newFile.getId());
  return newFile;
}

function saveSnapshot(map) {
  const keys = Object.keys(map);

  // Safeguard: không cho ghi snapshot rỗng nếu trước đó có dữ liệu, tránh mất toàn bộ cây theo dõi
  const file = getOrCreateSnapshotFile();
  const existingContent = file.getBlob().getDataAsString();
  let previousCount = 0;
  try {
    previousCount = Object.keys(JSON.parse(existingContent || "{}")).length;
  } catch (e) {
    previousCount = 0;
  }

  if (previousCount > 0) {
    if (keys.length === 0) {
      throw new Error("saveSnapshot: từ chối ghi đè snapshot rỗng lên snapshot đang có dữ liệu (trước đó có " + previousCount + " item)");
    }
    // Chặn nếu snapshot mới giảm bất thường (>50%) so với trước - dấu hiệu lỗi hàng loạt
    if (previousCount > 20 && keys.length < previousCount * 0.5) {
      throw new Error("saveSnapshot: từ chối ghi vì số item giảm bất thường (" + previousCount + " -> " + keys.length + "), có thể do lỗi API hàng loạt");
    }
  }

  file.setContent(JSON.stringify(map));
}

function loadSnapshot() {
  const file = getOrCreateSnapshotFile();
  const content = file.getBlob().getDataAsString();
  if (!content) return {};
  try {
    return JSON.parse(content);
  } catch (e) {
    return {};
  }
}

/* ================= KHỞI TẠO ================= */
function initDriveSnapshot() {
  const rootFolder = DriveApp.getFolderById(FOLDER_ID);
  const current = {};
  collectAll(rootFolder, ROOT_NAME, null, current);
  saveSnapshot(current);

  const tokenRes = Drive.Changes.getStartPageToken();
  PropertiesService.getScriptProperties().setProperty(TOKEN_PROP, tokenRes.startPageToken);
}

/* ================= KIỂM TRA XEM 1 FILE/FOLDER CÓ NẰM TRONG CÂY ĐANG THEO DÕI KHÔNG =================*/
function ensureInTree(fileId, snapshot, newlyAdded) {
  if (fileId === ROOT_ID) return snapshot[ROOT_ID] || null;
  if (snapshot[fileId]) return snapshot[fileId];

  let meta;
  try {
    meta = Drive.Files.get(fileId, { fields: "id,name,mimeType,modifiedTime,parents,trashed,webViewLink,md5Checksum,headRevisionId" });
  } catch (e) {
    Logger.log("ensureInTree lỗi khi lấy file " + fileId + ": " + e.message);
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
    url: meta.webViewLink || ("https://drive.google.com/open?id=" + fileId),
    md5: meta.md5Checksum || null,
    headRevisionId: meta.headRevisionId || null
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

/* ================= HÀM CHÍNH — gắn vào trigger ================= */
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
  const snapshotFileId = PropertiesService.getScriptProperties().getProperty(SNAPSHOT_FILE_ID_PROP);
  const newlyAdded = [];
  const pendingNotifications = [];
  let response;

  do {
    response = Drive.Changes.list(pageToken, {
      fields: "nextPageToken,newStartPageToken,changes(fileId,removed,file(id,name,mimeType,modifiedTime,trashed,parents,webViewLink,md5Checksum,headRevisionId))",
      pageSize: 100,
      includeRemoved: true
    });

    for (const change of (response.changes || [])) {
      const fileId = change.fileId;
      if (fileId === ROOT_ID) continue;
      if (fileId === snapshotFileId) continue; // bỏ qua chính file snapshot, tránh tự báo cáo về mình

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

      const newMd5 = meta.md5Checksum || null;
      const newHeadRevisionId = meta.headRevisionId || null;

      let updated = false;
      if (!old.isFolder) {
        if (old.md5 != null && newMd5 != null) {
          updated = old.md5 !== newMd5;
        } else if (old.headRevisionId != null && newHeadRevisionId != null) {
          updated = old.headRevisionId !== newHeadRevisionId;
        } else {
          updated = old.lastUpdated !== newModified;
        }
      }

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
        url: old.url,
        md5: newMd5,
        headRevisionId: newHeadRevisionId
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
         + `🎯 ${formatFileName(newItem.path)}`;
  } else if (type === "moved") {
    line = `${cfg.emoji} **${cfg.label}**\n`
         + `Tên: ${formatFileName(newItem.name)}\n`
         + `${formatFileName(fromPath)}\n`
         + `**⟶** ${formatFileName(toPath)}`;
  } else {
    line = `${cfg.emoji} **${cfg.label}**\n`
         + `Tên: ${formatFileName(newItem.name)}\n`
         + `🎯 ${formatFileName(newItem.path)}`;
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
  const MAX_DESC_LENGTH = 3800;       // giới hạn Discord: 4096 ký tự/description
  const MAX_TOTAL_PAYLOAD = 5500;     // chừa an toàn dưới giới hạn 6000 ký tự/message

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

  function embedSize(embed) {
    return (embed.title ? embed.title.length : 0)
         + (embed.description ? embed.description.length : 0)
         + (embed.footer && embed.footer.text ? embed.footer.text.length : 0);
  }

  let chunk = [];
  let chunkSize = 0;

  function flushChunk() {
    if (chunk.length === 0) return;
    postToDiscordWithRetry({ embeds: chunk });
    chunk = [];
    chunkSize = 0;
  }

  for (const embed of embeds) {
    const size = embedSize(embed);

    if (size > MAX_TOTAL_PAYLOAD) {
      flushChunk();
      postToDiscordWithRetry({ embeds: [embed] });
      continue;
    }

    if (chunkSize + size > MAX_TOTAL_PAYLOAD || chunk.length >= 10) {
      flushChunk();
    }

    chunk.push(embed);
    chunkSize += size;
  }
  flushChunk();
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

  Utilities.sleep(350);
}
