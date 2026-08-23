const WEBHOOK_URL = "https://discord.com/api/webhooks/...";
const FOLDER_ID = "1A5gyIKW9YOeYq8F11Pil1OBt55Lq8N5c";
const ROOT_ID = FOLDER_ID;
const ROOT_NAME = "SPOC";
const TOKEN_PROP = "DRIVE_PAGE_TOKEN";
const SNAPSHOT_FILENAME = "_drive_monitor_snapshot.json"; // file ẩn lưu snapshot, nằm ngoài thư mục theo dõi
const SNAPSHOT_FILE_ID_PROP = "SNAPSHOT_FILE_ID"; // lưu ID của file snapshot để truy cập nhanh, không cần tìm kiếm mỗi lần

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
    meta = Drive.Files.get(fileId, { fields: "id,name,mimeType,modifiedTime,parents,trashed,webViewLink,md5Checksum,headRevisionId" });
  } catch (e) {
    Logger.log("ensureInTree lỗi khi lấy file " + fileId + ": " + e.message);
    return null;
  }

  if (meta.trashed) {
    // Có thể là false-positive tạm thời (Drive API đôi khi báo trashed=true sai lệch lúc move/tạo nhanh).
    // Xác minh lại trước khi bỏ qua hẳn item này.
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

/* ================= BẢNG ÁNH XẠ personName -> EMAIL + TÊN HIỂN THỊ (lưu dưới dạng file CSV trên Drive) =================
   Khi gặp 1 personName chưa từng biết, code tự động thêm dòng mới vào CSV với tên "Chưa xác định".
   Muốn đặt tên thật cho người đó, chỉ cần mở file CSV trên Drive và sửa cột "ten_hien_thi",
   không cần sửa code. */
const USER_MAP_FILENAME = "_drive_monitor_user_map.csv";
const USER_MAP_FILE_ID_PROP = "USER_MAP_FILE_ID";

function getOrCreateUserMapFile() {
  const props = PropertiesService.getScriptProperties();
  const cachedId = props.getProperty(USER_MAP_FILE_ID_PROP);

  if (cachedId) {
    try {
      const f = DriveApp.getFileById(cachedId);
      if (!f.isTrashed()) return f;
    } catch (e) {}
  }

  const it = DriveApp.getFilesByName(USER_MAP_FILENAME);
  while (it.hasNext()) {
    const f = it.next();
    props.setProperty(USER_MAP_FILE_ID_PROP, f.getId());
    return f;
  }

  const header = "personName,email,ten_hien_thi\n";
  const newFile = DriveApp.createFile(USER_MAP_FILENAME, header, MimeType.PLAIN_TEXT);
  props.setProperty(USER_MAP_FILE_ID_PROP, newFile.getId());
  return newFile;
}

// Parse CSV đơn giản (không có dấu phẩy trong giá trị nên không cần parser phức tạp)
// map dạng: { personName: { email: "...", name: "..." } }
function loadUserMap() {
  const file = getOrCreateUserMapFile();
  const content = file.getBlob().getDataAsString();
  const map = {};

  const lines = content.split("\n").map(l => l.trim()).filter(l => l.length > 0);
  for (let i = 1; i < lines.length; i++) { // bỏ dòng header
    const parts = lines[i].split(",");
    if (parts.length >= 3) {
      const personName = parts[0].trim();
      const email = parts[1].trim();
      const displayName = parts.slice(2).join(",").trim(); // phòng trường hợp tên có dấu phẩy
      if (personName) map[personName] = { email: email, name: displayName };
    }
  }
  return map;
}

function saveUserMap(map) {
  const file = getOrCreateUserMapFile();
  let content = "personName,email,ten_hien_thi\n";
  for (const personName in map) {
    const entry = map[personName];
    content += personName + "," + (entry.email || "") + "," + (entry.name || "Chưa xác định") + "\n";
  }
  file.setContent(content);
}

// Tra tên theo personName. Nếu chưa có trong CSV, tự động thêm dòng mới với tên "Chưa xác định" và lưu lại ngay.
function resolveOrRegisterPersonName(personName) {
  const map = loadUserMap();

  if (map[personName]) {
    return map[personName].name || "Chưa xác định";
  }

  // Người mới, chưa từng gặp -> thêm vào CSV với tên mặc định, chưa có email
  map[personName] = { email: "", name: "Chưa xác định" };
  saveUserMap(map);
  Logger.log("Đã thêm người dùng mới vào CSV: " + personName + " (tên mặc định: Chưa xác định). Mở file " + USER_MAP_FILENAME + " trên Drive để đặt tên thật.");
  return "Chưa xác định";
}

// Gọi khi ta CHẮC CHẮN biết được email + tên thật của 1 personName (ví dụ qua Revisions API lúc update file).
// Tự động điền vào CSV, và nếu người đó đang là "Chưa xác định" thì nâng cấp thành tên thật luôn.
function learnPersonInfo(personName, email, displayName) {
  if (!personName || (!email && !displayName)) return;

  const map = loadUserMap();
  const existing = map[personName];

  const finalEmail = email || (existing ? existing.email : "");
  // Chỉ ghi đè tên nếu: chưa có entry, hoặc tên hiện tại đang là "Chưa xác định"/rỗng
  let finalName = existing ? existing.name : null;
  if (!finalName || finalName === "Chưa xác định") {
    finalName = displayName || email || "Chưa xác định";
  }

  const changed = !existing || existing.email !== finalEmail || existing.name !== finalName;
  if (changed) {
    map[personName] = { email: finalEmail, name: finalName };
    saveUserMap(map);
    Logger.log("Đã cập nhật thông tin cho " + personName + ": email=" + finalEmail + ", tên=" + finalName);
  }
}

/* ================= LẤY personName THÔ TỪ ACTIVITY (không resolve tên, dùng để đối chiếu chéo với Revisions) ================= */
function getPersonNameFromActivity(fileId) {
  try {
    const response = DriveActivity.Activity.query({
      itemName: "items/" + fileId,
      pageSize: 5,
      consolidationStrategy: { legacy: {} }
    });
    const activities = response.activities || [];
    for (const act of activities) {
      const actors = act.actors || [];
      for (const actor of actors) {
        if (actor.system) continue;
        if (actor.user && actor.user.knownUser && actor.user.knownUser.personName) {
          return actor.user.knownUser.personName;
        }
      }
    }
  } catch (e) {}
  return null;
}

/* ================= LẤY TÊN NGƯỜI VỪA XÓA / DI CHUYỂN / ĐỔI TÊN (dùng Drive Activity API + CSV đã học) =================
   Dùng cho các hành động mà Revisions API không có: delete, move, rename. */
function getActorNameFromActivity(fileId) {
  try {
    const response = DriveActivity.Activity.query({
      itemName: "items/" + fileId,
      pageSize: 10,
      consolidationStrategy: { legacy: {} }
    });

    const activities = response.activities || [];
    Logger.log("getActorNameFromActivity: " + activities.length + " activity cho file " + fileId);

    for (const act of activities) {
      const actors = act.actors || [];
      for (const actor of actors) {
        if (actor.system) continue;

        if (actor.user && actor.user.deletedUser) return "(người dùng đã xóa)";

        if (actor.user && actor.user.knownUser) {
          if (actor.user.knownUser.isCurrentUser) {
            const selfEmail = Session.getActiveUser().getEmail();
            return selfEmail || "Bạn";
          }

          const personName = actor.user.knownUser.personName;
          Logger.log("Actor personName: " + personName);

          if (personName) {
            return resolveOrRegisterPersonName(personName);
          }

          return "Người dùng khác (không rõ)";
        }
      }
    }
  } catch (e) {
    Logger.log("getActorNameFromActivity lỗi cho file " + fileId + ": " + e.message);
  }
  return null;
}

/* ================= HÀM TỔNG HỢP: chọn nguồn phù hợp theo loại hành động ================= */
function getLastModifierName(fileId, isFolder, actionType) {
  // Với update nội dung file: lấy tên+email chắc chắn từ Revisions API,
  // đồng thời "học" luôn thông tin này vào CSV gắn với personName tương ứng (nếu tìm được qua Activity)
  if (actionType === "updated" && !isFolder) {
    let viaRevisions = null;
    let revisionEmail = null;
    let revisionName = null;
    try {
      const res = Drive.Revisions.list(fileId, { fields: "revisions(lastModifyingUser(displayName,emailAddress))" });
      const revisions = res.revisions || [];
      if (revisions.length > 0) {
        const last = revisions[revisions.length - 1];
        if (last.lastModifyingUser) {
          revisionEmail = last.lastModifyingUser.emailAddress || null;
          revisionName = last.lastModifyingUser.displayName || null;
          viaRevisions = revisionName || revisionEmail || null;
        }
      }
    } catch (e) {}

    // Gọi Activity API đúng 1 lần: vừa để "dạy" CSV, vừa dùng luôn kết quả này nếu Revisions không có gì
    const personName = getPersonNameFromActivity(fileId);
    if (personName && (revisionEmail || revisionName)) {
      learnPersonInfo(personName, revisionEmail, revisionName);
    }

    if (viaRevisions) return viaRevisions;

    // Revisions không có dữ liệu -> dùng lại personName đã lấy được ở trên, không gọi Activity lần nữa
    if (personName) {
      return resolveOrRegisterPersonName(personName);
    }
  }

  // Với delete/move/rename hoặc khi Revisions không có dữ liệu: dùng Activity + CSV đã học được
  return getActorNameFromActivity(fileId);
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
  const userMapFileId = props.getProperty(USER_MAP_FILE_ID_PROP);
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
      if (fileId === userMapFileId) continue; // bỏ qua chính file CSV ánh xạ tên người dùng

      const wasTracked = !!snapshot[fileId];

      // --- Bị xóa / vào thùng rác ---
      // Lưu ý: Drive Changes API đôi khi trả trashed=true tạm thời trong lúc thực hiện move
      // (đặc biệt qua thao tác kéo-thả hoặc đồng bộ desktop). Để tránh báo nhầm "xóa" khi
      // thực chất chỉ là "di chuyển", xác minh lại trạng thái thật của file trước khi kết luận.
      if (change.removed || (change.file && change.file.trashed)) {
        if (wasTracked) {
          let reallyDeleted = true;

          if (!change.removed) {
            // change.removed=false nhưng trashed=true -> có thể là false positive, kiểm tra lại qua API
            try {
              const freshMeta = Drive.Files.get(fileId, { fields: "id,trashed,parents,name,mimeType,modifiedTime,webViewLink,md5Checksum,headRevisionId" });
              if (!freshMeta.trashed) {
                // Thực ra file/folder vẫn tồn tại bình thường -> đây là false positive, xử lý như 1 thay đổi thường
                // (rename/move/update) thay vì xóa. Đưa fileId trở lại hàng đợi xử lý bình thường.
                reallyDeleted = false;
                change.file = freshMeta; // cập nhật lại meta đúng để nhánh xử lý bên dưới dùng
              }
            } catch (e) {
              // Không lấy được -> có khả năng thực sự đã bị xóa hẳn (không phải chỉ trash), giữ nguyên reallyDeleted = true
            }
          }

          if (reallyDeleted) {
            const old = snapshot[fileId];
            const modifiedBy = getActorNameFromActivity(fileId);
            pendingNotifications.push(buildNotification(old.isFolder ? "deleted_folder" : "deleted_file", old, old, modifiedBy));
            delete snapshot[fileId];
            continue;
          }
          // reallyDeleted = false -> rơi xuống để xử lý như thay đổi bình thường bên dưới, không "continue" ở đây
        } else {
          // Item chưa từng được track: vẫn có thể là false-positive trashed (vừa tạo + move nhanh).
          // Xác minh lại trước khi bỏ qua hẳn, để không bỏ lỡ báo cáo "file/folder mới".
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
          const modifiedBy = getLastModifierName(fileId, entry.isFolder, "new");
          pendingNotifications.push(buildNotification(entry.isFolder ? "new_folder" : "new_file", entry, entry, modifiedBy));
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

      // Chỉ gọi API lấy tên người sửa 1 lần cho file này nếu có ít nhất 1 loại thay đổi thật sự xảy ra
      let modifiedBy = null;
      if (moved || renamed || updated) {
        const actionTypeForLookup = updated ? "updated" : (moved ? "moved" : "renamed");
        modifiedBy = getLastModifierName(fileId, old.isFolder, actionTypeForLookup);
      }

      let newLocationPath = old.path;

      if (moved) {
        const newParentEntry = getParentEntry(snapshot, newParentId);

        if (!newParentEntry) {
          // Bị chuyển ra ngoài phạm vi thư mục đang theo dõi -> coi như đã xóa
          pendingNotifications.push(buildNotification(old.isFolder ? "deleted_folder" : "deleted_file", old, old, modifiedBy));
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
          modifiedBy,
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
        pendingNotifications.push(buildNotification("renamed_and_updated", old, finalEntry, modifiedBy));
      } else if (renamed) {
        pendingNotifications.push(buildNotification("renamed", old, finalEntry, modifiedBy));
      } else if (updated) {
        pendingNotifications.push(buildNotification("updated", old, finalEntry, modifiedBy));
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

  if (modifiedBy) {
    line += `\n👤 Người sửa: ${modifiedBy}`;
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
