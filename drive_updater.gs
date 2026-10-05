const WEBHOOK_URL = "https://discord.com/api/webhooks/...";
const FOLDER_ID = "1A5gyIKW9YOeYq8F11Pil1OBt55Lq8N5c";
const ROOT_ID = FOLDER_ID;
const ROOT_NAME = "SPOC";
const TOKEN_PROP = "DRIVE_PAGE_TOKEN";
const SNAPSHOT_FILENAME = "_drive_monitor_snapshot.json"; // file ẩn lưu snapshot, nằm ngoài thư mục theo dõi
const SNAPSHOT_FILE_ID_PROP = "SNAPSHOT_FILE_ID"; // lưu ID của file snapshot để truy cập nhanh, không cần tìm kiếm mỗi lần
const WORKER_URL = "https://name.workers.dev";

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

// ================= WEB APP: RANDOM FILE OPENER =================

const CASE_OPENING_ALLOWED_EXTENSIONS = [".docx", ".pdf"];
const CASE_OPENING_TICKET_TTL_SECONDS = 120; // ticket hết hạn sau 2 phút nếu không reveal kịp
// const CASE_OPENING_SECRET = "806f239e-0a9f-4e9a-8b07-88835bf8b98c4e990e1edbeb408d962c2ac669d75dff";

function doGet(e) {
  const token = e.parameter.token;
  if (token !== CASE_OPENING_SECRET) {
    return ContentService
      .createTextOutput(JSON.stringify({ error: "Unauthorized" }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  const action = e.parameter.action;

  let result;
  if (action === "list") {
    result = handleCaseOpeningList_();
  } else if (action === "reveal") {
    result = handleCaseOpeningReveal_(e.parameter.ticket);
  } else {
    result = { error: "Unknown action" };
  }

  return ContentService
    .createTextOutput(JSON.stringify(result))
    .setMimeType(ContentService.MimeType.JSON);
}

// Lấy danh sách file .docx/.pdf từ snapshot, KHÔNG trả fileId/link thật.
// Random sẵn 1 file "thắng", tạo ticket ngẫu nhiên, lưu ánh xạ ticket -> fileId thật vào Cache.
function handleCaseOpeningList_() {
  const snapshot = loadSnapshot();
  const candidates = [];

  for (const fileId in snapshot) {
    const entry = snapshot[fileId];
    if (entry.isFolder) continue;

    const lowerName = entry.name.toLowerCase();
    const matchesExt = CASE_OPENING_ALLOWED_EXTENSIONS.some(ext => lowerName.endsWith(ext));
    if (!matchesExt) continue;

    candidates.push({ fileId: fileId, name: entry.name });
  }

  if (candidates.length === 0) {
    return { error: "Không có file .docx/.pdf nào trong thư mục" };
  }

  // Random 1 file thắng ngay tại đây (server-side), không để client tự chọn
  const winnerIndex = Math.floor(Math.random() * candidates.length);
  const winner = candidates[winnerIndex];

  // Tạo ticket ngẫu nhiên không đoán được, lưu ánh xạ ticket -> fileId thật trong Cache (tạm thời)
  const ticket = Utilities.getUuid();
  const cache = CacheService.getScriptCache();
  cache.put("ticket_" + ticket, winner.fileId, CASE_OPENING_TICKET_TTL_SECONDS);

  // Trả về: danh sách TÊN file để hiệu ứng quay hiển thị (không có link, không có fileId thật),
  // kèm ticket để client gọi action=reveal sau khi hiệu ứng quay xong,
  // và tên file thắng (để UI biết dừng quay đúng chỗ) nhưng KHÔNG kèm fileId/link của nó.
  return {
    items: candidates.map(c => ({ name: c.name })), // ẩn fileId thật khỏi toàn bộ danh sách
    winnerName: winner.name,
    ticket: ticket
  };
}

// Nhận ticket, trả về link Drive thật tương ứng. Ticket chỉ dùng được 1 lần.
function handleCaseOpeningReveal_(ticket) {
  if (!ticket) {
    return { error: "Thiếu ticket" };
  }

  const cache = CacheService.getScriptCache();
  const cacheKey = "ticket_" + ticket;
  const fileId = cache.get(cacheKey);

  if (!fileId) {
    return { error: "Ticket không hợp lệ hoặc đã hết hạn" };
  }

  cache.remove(cacheKey); // dùng 1 lần, xóa ngay sau khi reveal

  const snapshot = loadSnapshot();
  const entry = snapshot[fileId];

  if (!entry) {
    return { error: "File không còn tồn tại" };
  }

  return {
    name: entry.name,
    url: entry.url
  };
}

function pushFileListToWorker() {
  const snapshot = loadSnapshot();
  const files = [];

  for (const id in snapshot) {
    const entry = snapshot[id];
    if (entry.isFolder) continue;
    const lowerName = entry.name.toLowerCase();
    if (!CASE_OPENING_ALLOWED_EXTENSIONS.some(ext => lowerName.endsWith(ext))) continue;
    files.push({ n: entry.name, u: entry.url });
  }

  if (files.length === 0) {
    Logger.log("pushFileListToWorker: không có file .docx/.pdf, bỏ qua");
    return;
  }

  const res = UrlFetchApp.fetch(WORKER_URL + "/admin/update", {
    method: "post",
    contentType: "application/json",
    headers: { Authorization: "Bearer " + PropertiesService.getScriptProperties().getProperty("WORKER_ADMIN_SECRET") },
    payload: JSON.stringify(files),
    muteHttpExceptions: true
  });

  Logger.log("pushFileListToWorker: " + res.getResponseCode() + " " + res.getContentText().substring(0, 200));
}
