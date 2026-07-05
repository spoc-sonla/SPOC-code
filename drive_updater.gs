const WEBHOOK_URL = "https://discord.com/api/webhooks/...";
const FOLDER_ID = "...";
const ROOT_NAME = "SPOC";
const PROP_PREFIX = "SNAP_";
const TOKEN_PROP = "DRIVE_PAGE_TOKEN";

/* ================= THU THẬP TOÀN BỘ CÂY THƯ MỤC (dùng khi khởi tạo) ================= */
function collectAll(folder, path, parentId, map) {
  map[folder.getId()] = {
    name: folder.getName(),
    path: path, // với folder: path = đường dẫn đầy đủ của CHÍNH nó
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
  if (fileId === FOLDER_ID) return snapshot[FOLDER_ID] || null;
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
  if (parentId === FOLDER_ID) return snapshot[FOLDER_ID] || null;
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
  const props = PropertiesService.getScriptProperties();
  let pageToken = props.getProperty(TOKEN_PROP);

  if (!pageToken) {
    initDriveSnapshot();
    return;
  }

  const snapshot = loadSnapshot();
  const newlyAdded = [];
  let response;

  do {
    response = Drive.Changes.list(pageToken, {
      fields: "nextPageToken,newStartPageToken,changes(fileId,removed,file(id,name,mimeType,modifiedTime,trashed,parents,webViewLink))",
      pageSize: 100,
      includeRemoved: true
    });

    for (const change of (response.changes || [])) {
      const fileId = change.fileId;
      if (fileId === FOLDER_ID) continue; // bỏ qua thư mục gốc

      const wasTracked = !!snapshot[fileId];

      // --- Bị xóa / vào thùng rác ---
      if (change.removed || (change.file && change.file.trashed)) {
        if (wasTracked) {
          const old = snapshot[fileId];
          sendDiscord(old.isFolder ? "deleted_folder" : "deleted_file", old, old);
          delete snapshot[fileId];
        }
        continue;
      }

      if (!change.file) continue;
      const meta = change.file;

      // --- Mới xuất hiện ---
      if (!wasTracked) {
        const entry = ensureInTree(fileId, snapshot, newlyAdded);
        if (entry) {
          sendDiscord(entry.isFolder ? "new_folder" : "new_file", entry, entry);
        }
        continue;
      }

      // --- Đã theo dõi từ trước: kiểm tra move / rename / update ---
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
          // Bị chuyển ra ngoài phạm vi thư mục đang theo dõi -> coi như đã xóa
          sendDiscord(old.isFolder ? "deleted_folder" : "deleted_file", old, old);
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

        sendDiscord(
          "moved",
          old,
          { name: meta.name, path: newLocationPath, parentId: newParentId, isFolder: old.isFolder, lastUpdated: newModified, url: old.url },
          null,
          oldFullPath,
          newFullPath
        );
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
        sendDiscord("renamed_and_updated", old, finalEntry);
      } else if (renamed) {
        sendDiscord("renamed", old, finalEntry);
      } else if (updated) {
        sendDiscord("updated", old, finalEntry);
      }

      snapshot[fileId] = finalEntry;
    }

    pageToken = response.nextPageToken;
  } while (pageToken);

  saveSnapshot(snapshot);
  props.setProperty(TOKEN_PROP, response.newStartPageToken);
}

/* ================= FORMAT TÊN FILE (tránh Discord parse nhầm markdown _ * ~ `) ================= */
function formatFileName(text) {
  if (!text) return "(trống)";
  const safe = text.replace(/`/g, "'");
  return "`" + safe + "`";
}

/* ================= GỬI THÔNG BÁO DISCORD ================= */
function sendDiscord(type, oldItem, newItem, modifiedBy, fromPath, toPath) {
  const CONFIG = {
    new_file:            { title: "📄 File mới",             color: 3066993 },
    new_folder:          { title: "📁 Thư mục mới",          color: 3066993 },
    deleted_file:        { title: "🗑️ File bị xóa",          color: 15158332 },
    deleted_folder:      { title: "🗑️ Thư mục bị xóa",       color: 15158332 },
    renamed:             { title: "✏️ Đổi tên",              color: 15844367 },
    updated:             { title: "🔄 Cập nhật nội dung",     color: 5793266 },
    renamed_and_updated: { title: "✏️🔄 Đổi tên & cập nhật",  color: 15105570 },
    moved:               { title: "📦 Đã di chuyển",          color: 3447003 }
  };

  const cfg = CONFIG[type] || { title: "Thay đổi Drive", color: 5763719 };
  const fields = [];

  if (type === "renamed" || type === "renamed_and_updated") {
    fields.push({ name: "Tên cũ", value: formatFileName(oldItem.name), inline: true });
    fields.push({ name: "Tên mới", value: formatFileName(newItem.name), inline: true });
  } else {
    fields.push({ name: "Tên", value: formatFileName(newItem.name), inline: false });
  }

  if (type === "moved") {
    fields.push({ name: "Từ thư mục", value: formatFileName(fromPath), inline: false });
    fields.push({ name: "Đến thư mục", value: formatFileName(toPath), inline: false });
  } else {
    fields.push({ name: "Vị trí", value: formatFileName(newItem.path), inline: false });
  }

  if (modifiedBy) {
    fields.push({ name: "Người sửa gần nhất", value: modifiedBy, inline: true });
  }

  fields.push({ name: "Thời gian", value: new Date().toLocaleString("vi-VN"), inline: true });

  if (type !== "deleted_file" && type !== "deleted_folder") {
    fields.push({ name: "Liên kết", value: newItem.url, inline: false });
  }

  const data = {
    embeds: [{
      title: cfg.title,
      color: cfg.color,
      fields: fields
    }]
  };

  UrlFetchApp.fetch(WEBHOOK_URL, {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify(data)
  });
}
