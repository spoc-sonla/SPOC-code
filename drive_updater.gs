const WEBHOOK_URL = "https://discord.com/api/webhooks/...";
const FOLDER_ID = "1A5gyIKW9YOeYq8F11Pil1OBt55Lq8N5c";
const ROOT_ID = FOLDER_ID;
const ROOT_NAME = "SPOC";
const TOKEN_PROP = "DRIVE_PAGE_TOKEN";
const SNAPSHOT_FILENAME = "_drive_monitor_snapshot.json";
const SNAPSHOT_FILE_ID_PROP = "SNAPSHOT_FILE_ID"; 
const WORKER_URL = "https://name.workers.dev";
const EXTRA_FOLDER_IDS = [
  "1v3cw_Ul4NMk39GMsJ2uBuBiX2mkbP08V",
  "1i4sBVRN_YabbVDIJvGK9tI3bAkwpiYX2",
];

function taoSecret() {
  Logger.log(Utilities.getUuid() + Utilities.getUuid().replace(/-/g, ""));
}

function emergencyReset() {
  PropertiesService.getScriptProperties().deleteProperty(TOKEN_PROP);
  initDriveSnapshot(); // rebuild lại toàn bộ cây + lấy token mới nhất
  Logger.log("Đã reset xong, số item: " + Object.keys(loadSnapshot()).length);
}

/* ================= THU THẬP TOÀN BỘ CÂY THƯ MỤC (dùng khi khởi tạo) =================
   Dùng Drive.Files.list theo từng folder (lấy cả file lẫn folder con trong 1 lệnh gọi,
   kèm sẵn md5Checksum/headRevisionId) thay vì gọi Drive.Files.get riêng lẻ cho từng file. */
function collectAll(folderId, folderName, path, parentId, map) {
  let rootLastUpdated = Date.now();
  let rootUrl = "https://drive.google.com/drive/folders/" + folderId;
  try {
    const rootMeta = Drive.Files.get(folderId, { fields: "modifiedTime,webViewLink" });
    rootLastUpdated = new Date(rootMeta.modifiedTime).getTime();
    rootUrl = rootMeta.webViewLink || rootUrl;
  } catch (e) {}

  map[folderId] = {
    name: folderName,
    path: path,
    parentId: parentId,
    isFolder: true,
    lastUpdated: rootLastUpdated,
    url: rootUrl
  };

  const subFolders = [];
  let pageToken = null;

  do {
    const res = Drive.Files.list({
      q: "'" + folderId + "' in parents and trashed = false",
      fields: "nextPageToken,files(id,name,mimeType,modifiedTime,webViewLink,md5Checksum,headRevisionId)",
      pageSize: 1000,
      pageToken: pageToken
    });

    const items = res.files || [];
    for (const item of items) {
      const isFolder = item.mimeType === "application/vnd.google-apps.folder";

      if (isFolder) {
        subFolders.push({ id: item.id, name: item.name });
      } else {
        map[item.id] = {
          name: item.name,
          path: path,
          parentId: folderId,
          isFolder: false,
          lastUpdated: new Date(item.modifiedTime).getTime(),
          url: item.webViewLink || ("https://drive.google.com/open?id=" + item.id),
          md5: item.md5Checksum || null,
          headRevisionId: item.headRevisionId || null
        };
      }
    }

    pageToken = res.nextPageToken;
  } while (pageToken);

  for (const sub of subFolders) {
    const newPath = path + "/" + sub.name;
    collectAll(sub.id, sub.name, newPath, folderId, map);
  }
}

/* ================= LƯU / ĐỌC SNAPSHOT (lưu dưới dạng 1 file JSON trên Drive, không giới hạn 500KB như PropertiesService) ================= */
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

/* ================= KHỞI TẠO (chạy 1 lần đầu tiên, hoặc khi cần reset) ================= */
function initDriveSnapshot() {
  const current = {};
  collectAll(FOLDER_ID, ROOT_NAME, ROOT_NAME, null, current);
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
    meta = Drive.Files.get(fileId, { fields: "id,name,mimeType,modifiedTime,parents,trashed,webViewLink,md5Checksum,headRevisionId" });
  } catch (e) {
    Logger.log("ensureInTree lỗi khi lấy file " + fileId + ": " + e.message);
    return null;
  }

  if (meta.trashed) {
    try {
      const recheck = Drive.Files.get(fileId, { fields: "trashed" });
      if (recheck.trashed) return null; // xác nhận thực sự đã bị xóa
      // Không thực sự trashed -> tiếp tục xử lý bình thường bên dưới với meta hiện có
    } catch (e) {
      return null; // không lấy lại được, coi như không hợp lệ
    }
  }
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
  const snapshotFileId = props.getProperty(SNAPSHOT_FILE_ID_PROP);
  const newlyAdded = [];
  const pendingNotifications = [];
  let response;

  do {
    response = Drive.Changes.list(pageToken, {
      fields: "nextPageToken,newStartPageToken,changes(fileId,removed,file(id,name,mimeType,modifiedTime,trashed,parents,webViewLink,md5Checksum,headRevisionId))",
      pageSize: 100,
      includeRemoved: true
    });

    const rawChanges = response.changes || [];
    // Xử lý thư mục trước file trong cùng batch: đảm bảo path của thư mục cha
    // đã được cập nhật (nếu cha cũng vừa bị move) trước khi các item con dùng tới path đó.
    const sortedChanges = rawChanges.slice().sort((a, b) => {
      const aIsFolder = a.file && a.file.mimeType === "application/vnd.google-apps.folder" ? 0 : 1;
      const bIsFolder = b.file && b.file.mimeType === "application/vnd.google-apps.folder" ? 0 : 1;
      return aIsFolder - bIsFolder;
    });

    for (const change of sortedChanges) {
      const fileId = change.fileId;
      if (fileId === ROOT_ID) continue;
      if (fileId === snapshotFileId) continue; // bỏ qua chính file snapshot, tránh tự báo cáo về mình

      const wasTracked = !!snapshot[fileId];
      if (change.removed || (change.file && change.file.trashed)) {
        if (wasTracked) {
          let reallyDeleted = true;

          if (!change.removed) {
            // change.removed=false nhưng trashed=true -> có thể là false positive, kiểm tra lại qua API
            try {
              const freshMeta = Drive.Files.get(fileId, { fields: "id,trashed,parents,name,mimeType,modifiedTime,webViewLink,md5Checksum,headRevisionId" });
              if (!freshMeta.trashed) {
                reallyDeleted = false;
                change.file = freshMeta;
              }
            } catch (e) {
              // Không lấy được -> có khả năng thực sự đã bị xóa hẳn (không phải chỉ trash), giữ nguyên reallyDeleted = true
            }
          }

          if (reallyDeleted) {
            const old = snapshot[fileId];
            pendingNotifications.push(buildNotification(old.isFolder ? "deleted_folder" : "deleted_file", old, old));
            delete snapshot[fileId];
            continue;
          }
          // reallyDeleted = false -> rơi xuống để xử lý như thay đổi bình thường bên dưới, không "continue" ở đây
        } else {
          if (!change.removed) {
            try {
              const freshMeta = Drive.Files.get(fileId, { fields: "id,trashed,parents,name,mimeType,modifiedTime,webViewLink,md5Checksum,headRevisionId" });
              if (!freshMeta.trashed) {
                change.file = freshMeta; // rơi xuống xử lý như item mới bình thường
              } else {
                continue;
              }
            } catch (e) {
              continue;
            }
          } else {
            continue;
          }
        }
      }

      if (!change.file) continue;
      const meta = change.file;

      // --- Mới xuất hiện ---
      if (!wasTracked) {
        const entry = ensureInTree(fileId, snapshot, newlyAdded);
        if (entry) {
          pendingNotifications.push(buildNotification(entry.isFolder ? "new_folder" : "new_file", entry, entry));
        }
        continue;
      }

      // --- Đã theo dõi từ trước: kiểm tra move / rename / update ---
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
          // Bị chuyển ra ngoài phạm vi thư mục đang theo dõi -> coi như đã xóa
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
function buildNotification(type, oldItem, newItem, fromPath, toPath) {
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

// ================= RANDOM FILE OPENER: ĐẨY DANH SÁCH FILE LÊN CLOUDFLARE WORKER =================

const CASE_OPENING_ALLOWED_EXTENSIONS = [".docx", ".pdf"];

const EXTRA_CACHE_FILENAME = "_extra_files_cache.json";
const EXTRA_CACHE_ID_PROP = "EXTRA_CACHE_FILE_ID";
const FOLDER_MIME = "application/vnd.google-apps.folder";
const SHORTCUT_MIME = "application/vnd.google-apps.shortcut";
const EXTRA_MIME_TO_EXT = {
  "application/pdf": ".pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx"
};

function getExtraCacheFile() {
  const props = PropertiesService.getScriptProperties();
  const cachedId = props.getProperty(EXTRA_CACHE_ID_PROP);
  if (cachedId) {
    try {
      const f = DriveApp.getFileById(cachedId);
      if (!f.isTrashed()) return f;
    } catch (e) {}
  }
  const newFile = DriveApp.createFile(EXTRA_CACHE_FILENAME, "{}", MimeType.PLAIN_TEXT);
  props.setProperty(EXTRA_CACHE_ID_PROP, newFile.getId());
  return newFile;
}

function loadExtraCache() {
  try {
    return JSON.parse(getExtraCacheFile().getBlob().getDataAsString() || "{}");
  } catch (e) {
    return {};
  }
}

function extraDisplayName(item) {
  const lowerName = item.name.toLowerCase();
  if (CASE_OPENING_ALLOWED_EXTENSIONS.some(ext => lowerName.endsWith(ext))) return item.name;
  const mimeExt = EXTRA_MIME_TO_EXT[item.mimeType];
  return mimeExt ? item.name + mimeExt : null;
}

function driveListRequest(folderId, pageToken) {
  const q = "'" + folderId + "' in parents and trashed = false";
  let url = "https://www.googleapis.com/drive/v3/files"
    + "?q=" + encodeURIComponent(q)
    + "&fields=" + encodeURIComponent("nextPageToken,files(id,name,mimeType,webViewLink,shortcutDetails)")
    + "&pageSize=1000&supportsAllDrives=true&includeItemsFromAllDrives=true";
  if (pageToken) url += "&pageToken=" + encodeURIComponent(pageToken);
  return {
    url: url,
    method: "get",
    headers: { Authorization: "Bearer " + ScriptApp.getOAuthToken() },
    muteHttpExceptions: true
  };
}

function scanTree(rootId, deadline) {
  const out = [];
  const stats = { requests: 0, items: 0, folders: 0, errors: 0, lastError: "", mime: {} };
  const seenFolders = {};
  const seenFiles = {};
  seenFolders[rootId] = true;
  let queue = [{ id: rootId, token: null, tries: 0 }];

  while (queue.length > 0) {
    if (Date.now() > deadline) throw new Error("hết thời gian quét");
    const batch = queue.splice(0, 40);
    const responses = UrlFetchApp.fetchAll(batch.map(t => driveListRequest(t.id, t.token)));
    stats.requests += batch.length;
    const retry = [];

    responses.forEach((res, i) => {
      const task = batch[i];
      const code = res.getResponseCode();
      const text = res.getContentText();

      if (code !== 200) {
        const rateLimited = code === 429 || code >= 500 || (code === 403 && text.indexOf("ateLimit") !== -1);
        task.tries++;
        if (rateLimited && task.tries <= 5) {
          retry.push(task);
        } else {
          stats.errors++;
          stats.lastError = "HTTP " + code + " " + text.substring(0, 160).replace(/\s+/g, " ");
        }
        return;
      }

      const data = JSON.parse(text);
      for (const item of (data.files || [])) {
        stats.items++;
        if (item.mimeType === FOLDER_MIME) {
          stats.folders++;
          if (!seenFolders[item.id]) {
            seenFolders[item.id] = true;
            queue.push({ id: item.id, token: null, tries: 0 });
          }
        } else if (item.mimeType === SHORTCUT_MIME) {
          const d = item.shortcutDetails;
          if (d && d.targetMimeType === FOLDER_MIME && !seenFolders[d.targetId]) {
            seenFolders[d.targetId] = true;
            queue.push({ id: d.targetId, token: null, tries: 0 });
          }
        } else {
          stats.mime[item.mimeType] = (stats.mime[item.mimeType] || 0) + 1;
          const displayName = extraDisplayName(item);
          if (!displayName || seenFiles[item.id]) continue;
          seenFiles[item.id] = true;
          out.push({ id: item.id, n: displayName, u: item.webViewLink || ("https://drive.google.com/open?id=" + item.id) });
        }
      }
      if (data.nextPageToken) queue.push({ id: task.id, token: data.nextPageToken, tries: 0 });
    });

    if (retry.length > 0) {
      Utilities.sleep(1500);
      queue = retry.concat(queue);
    }
  }
  return { files: out, stats: stats };
}

function spocFromSnapshot() {
  const snapshot = loadSnapshot();
  const list = [];
  for (const id in snapshot) {
    const entry = snapshot[id];
    if (entry.isFolder) continue;
    const lowerName = entry.name.toLowerCase();
    if (!CASE_OPENING_ALLOWED_EXTENSIONS.some(ext => lowerName.endsWith(ext))) continue;
    list.push({ id: id, n: entry.name, u: entry.url });
  }
  return list;
}

function kiemTraSnapshot() {
  const file = getOrCreateSnapshotFile();
  const content = file.getBlob().getDataAsString();
  let parsed = null;
  try {
    parsed = JSON.parse(content || "{}");
  } catch (e) {
    Logger.log("Snapshot KHÔNG đọc được (JSON lỗi): " + e.message);
  }
  Logger.log("File snapshot: " + file.getName() + " | id " + file.getId() + " | " + content.length + " ký tự | sửa lần cuối " + file.getLastUpdated());
  if (parsed) {
    const total = Object.keys(parsed).length;
    Logger.log("Số mục trong snapshot: " + total + " | file .pdf/.docx: " + spocFromSnapshot().length);
  }
}

function pushFileListToWorker() {
  const scanDeadline = Date.now() + 240000;
  const lines = [];
  const names = [];
  const seen = {};

  function add(id, name, url) {
    if (seen[id]) return false;
    seen[id] = true;
    const cleanName = String(name).replace(/[\t\r\n]+/g, " ");
    lines.push(cleanName + "\t" + url);
    names.push({ name: cleanName });
    return true;
  }

  const old = loadExtraCache();
  const fresh = {};
  const counts = { spoc: 0, extra: 0 };
  const roots = [{ id: ROOT_ID, label: "SPOC" }].concat(EXTRA_FOLDER_IDS.map(id => ({ id: id, label: "Ngoài " + id })));

  for (const root of roots) {
    let list;
    try {
      let targetId = root.id;
      if (root.id !== ROOT_ID) {
        const meta = Drive.Files.get(root.id, { fields: "id,mimeType,shortcutDetails", supportsAllDrives: true });
        if (meta.mimeType === SHORTCUT_MIME && meta.shortcutDetails) targetId = meta.shortcutDetails.targetId;
      }

      const result = scanTree(targetId, scanDeadline);
      const s = result.stats;
      list = result.files;
      Logger.log("[" + root.label + "] " + s.requests + " request, duyệt " + s.items + " mục (" + s.folders + " thư mục), khớp " + list.length + " file" + (s.errors ? ", LỖI " + s.errors + " request: " + s.lastError : ""));
      if (list.length === 0) Logger.log("  các loại file tìm thấy: " + JSON.stringify(s.mime));

      const before = old[root.id] ? old[root.id].length : 0;
      if (before > 20 && list.length < before * 0.5) {
        Logger.log("  số file giảm bất thường (" + before + " -> " + list.length + "), giữ bản cũ");
        list = old[root.id];
      }
    } catch (e) {
      Logger.log("[" + root.label + "] Lỗi quét: " + e.message + (old[root.id] ? " -> dùng bản cũ" : ""));
      list = old[root.id] || [];
    }

    if (root.id === ROOT_ID && list.length === 0) {
      list = spocFromSnapshot();
      Logger.log("[SPOC] quét trực tiếp không ra file, dùng snapshot: " + list.length + " file");
    }

    fresh[root.id] = list;
    for (const f of list) {
      if (add(f.id, f.n, f.u)) {
        if (root.id === ROOT_ID) counts.spoc++;
        else counts.extra++;
      }
    }
  }

  try {
    getExtraCacheFile().setContent(JSON.stringify(fresh));
  } catch (e) {
    Logger.log("Không lưu được cache: " + e.message);
  }

  if (lines.length === 0) {
    Logger.log("pushFileListToWorker: không có file .docx/.pdf, bỏ qua");
    return;
  }

  const options = {
    method: "post",
    contentType: "text/plain; charset=utf-8",
    headers: { Authorization: "Bearer " + PropertiesService.getScriptProperties().getProperty("WORKER_ADMIN_SECRET") },
    muteHttpExceptions: true
  };

  const responses = UrlFetchApp.fetchAll([
    Object.assign({ url: WORKER_URL + "/admin/update?key=files", payload: lines.join("\n") }, options),
    Object.assign({ url: WORKER_URL + "/admin/update?key=names", payload: JSON.stringify({ items: names }) }, options)
  ]);

  responses.forEach((r, i) => {
    Logger.log("push " + (i === 0 ? "files" : "names") + ": " + r.getResponseCode() + " " + r.getContentText().substring(0, 200));
  });
  Logger.log("Đã đẩy " + lines.length + " file (SPOC: " + counts.spoc + ", thư mục ngoài: " + counts.extra + ")");
}
