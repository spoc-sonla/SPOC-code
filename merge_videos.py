import os
import subprocess
import tempfile

# ============================================================
#  CAU HINH - chinh sua cac bien duoi day
# ============================================================

INPUT_DIR   = r""       # Thư mục chứa file MP4 nguồn
OUTPUT_DIR  = r""      # Thư mục xuất file kết quả
OUTPUT_NAME = "output.mp4"             # Tên file xuất

PREFIX = "20260619"   # Tên file phải BẮT ĐẦU bằng chuỗi này (không phân biệt hoa thường)
                  # Đặt "NONE" nếu không cần điều kiện này

SUFFIX = "F"   # Tên file phải KẾT THÚC bằng chuỗi này (trước .mp4, không phân biệt hoa thường)
                  # Đặt "NONE" nếu không cần điều kiện này

SPEED  = 1.0      # Tốc độ phát (ví dụ: 2.0 = nhanh gấp đôi, 1.5 = nhanh gấp 1.5 lần)

MUTE = False    # True = bỏ toàn bộ audio, False = giữ audio (và tăng tốc cùng video)

CODEC = "H264"    # "H264" hoặc "H265" - chọn chuẩn nén mong muốn

OUTPUT_FPS = "AUTO"   # "AUTO" = giữ nguyên fps gốc của file nguồn (làm tròn số nguyên)
                      # Hoặc đặt số cụ thể, ví dụ: 60, 30, 24, 120...

# VIDEO_QUALITY: 1=tot nhat, 25=trung binh, 51=te nhat
VIDEO_QUALITY = 20
AUDIO_BITRATE = "192k"

# ============================================================

def find_matching_files(input_dir, prefix, suffix):
    prefix_lower = prefix.lower() if prefix != "NONE" else None
    suffix_lower = suffix.lower() if suffix != "NONE" else None
    matched = []
    for fname in os.listdir(input_dir):
        if not fname.lower().endswith(".mp4"):
            continue
        stem_lower = fname.lower()[:-4]
        if prefix_lower and not stem_lower.startswith(prefix_lower):
            continue
        if suffix_lower and not stem_lower.endswith(suffix_lower):
            continue
        matched.append(os.path.join(input_dir, fname))
    matched.sort()
    return matched


def build_atempo_chain(speed):
    remaining = speed
    chain = []
    while remaining > 2.0:
        chain.append("atempo=2.0")
        remaining /= 2.0
    chain.append(f"atempo={max(remaining, 0.5):.4f}")
    return ",".join(chain)


def check_has_audio(filepath):
    result = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "a",
         "-show_entries", "stream=codec_type", "-of", "default=noprint_wrappers=1",
         filepath],
        capture_output=True, text=True
    )
    return "audio" in result.stdout


def get_framerate(filepath):
    result = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=r_frame_rate",
         "-of", "default=noprint_wrappers=1:nokey=1", filepath],
        capture_output=True, text=True
    )
    try:
        val = result.stdout.strip()
        if "/" in val:
            num, den = val.split("/")
            return float(num) / float(den)
        return float(val)
    except Exception:
        return 30.0


def check_encoder_available(encoder_name):
    result = subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error",
         "-f", "lavfi", "-i", "color=black:size=320x240:rate=30",
         "-frames:v", "1",
         "-c:v", encoder_name,
         "-f", "null", "-"],
        capture_output=True, text=True
    )
    return result.returncode == 0


def get_encoder_for_codec(codec_choice):
    """
    NVIDIA NVENC -> Intel Quick Sync -> AMD AMF -> cuoi cung fallback ve CPU.
    Tra ve (encoder_name, label_de_hien_thi, encoder_type).
    """
    codec_choice = codec_choice.upper()
    if codec_choice == "H265":
        candidates = [
            ("hevc_nvenc", "NVIDIA NVENC (H.265)", "nvenc"),
            ("hevc_qsv",   "Intel Quick Sync (H.265)", "qsv"),
            ("hevc_amf",   "AMD AMF (H.265)", "amf"),
        ]
        cpu_encoder, cpu_label = "libx265", "libx265 (CPU - H.265)"
    else:
        candidates = [
            ("h264_nvenc", "NVIDIA NVENC (H.264)", "nvenc"),
            ("h264_qsv",   "Intel Quick Sync (H.264)", "qsv"),
            ("h264_amf",   "AMD AMF (H.264)", "amf"),
        ]
        cpu_encoder, cpu_label = "libx264", "libx264 (CPU - H.264)"

    for encoder_name, label, enc_type in candidates:
        if check_encoder_available(encoder_name):
            return encoder_name, label, enc_type

    # Khong co GPU nao dung duoc -> dung CPU
    return cpu_encoder, cpu_label, "cpu"


def get_quality_flags(encoder_type, quality):
    if encoder_type == "nvenc":
        return ["-rc", "vbr", "-cq", str(quality), "-b:v", "0"]
    if encoder_type == "qsv":
        return ["-global_quality", str(quality), "-look_ahead", "1"]
    if encoder_type == "amf":
        return ["-rc", "cqp", "-qp_i", str(quality), "-qp_p", str(quality), "-qp_b", str(quality)]
    # CPU (libx264 / libx265)
    return ["-crf", str(quality), "-preset", "fast"]


def main():
    # 1. Tim file
    print(f"[1/4] Tim file MP4 trong: {INPUT_DIR}")
    print(f"      PREFIX={PREFIX!r}  SUFFIX={SUFFIX!r}")
    files = find_matching_files(INPUT_DIR, PREFIX, SUFFIX)

    if not files:
        print("      Khong tim thay file nao thoa dieu kien.")
        return

    print(f"      Tim thay {len(files)} file:")
    for f in files:
        print(f"        {os.path.basename(f)}")

    # 2. Dò encoder phù hợp (tự động, chạy được cả máy có/không có GPU)
    print(f"\n[2/4] Dò phần cứng tăng tốc cho chuẩn nén {CODEC}...")
    codec, encoder_label, encoder_type = get_encoder_for_codec(CODEC)
    print(f"      Encoder: {encoder_label}")

    # Doc framerate goc (dung lam moc hien thi, va lam fallback neu OUTPUT_FPS=AUTO)
    src_fps = get_framerate(files[0])
    if isinstance(OUTPUT_FPS, str) and OUTPUT_FPS.strip().upper() == "AUTO":
        out_fps = round(src_fps)  # giu fps goc, lam tron vi mot so encoder GPU chi nhan fps nguyen
        print(f"      FPS nguon: {src_fps:.3f} -> output fps (AUTO): {out_fps}")
    else:
        out_fps = round(float(OUTPUT_FPS))
        print(f"      FPS nguon: {src_fps:.3f} -> output fps (tuy chinh): {out_fps}")

    # 3. Tao file danh sach concat
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    with tempfile.NamedTemporaryFile(mode="w", suffix=".txt",
                                     delete=False, encoding="utf-8") as tmp:
        list_path = tmp.name
        for f in files:
            safe_path = f.replace("\\", "/").replace("'", "\\'")
            tmp.write(f"file '{safe_path}'\n")

    output_path = os.path.join(OUTPUT_DIR, OUTPUT_NAME)
    has_audio   = check_has_audio(files[0])
    vf          = f"setpts={1/SPEED:.6f}*PTS,fps={out_fps}"  # fps filter dam bao encoder GPU nhan duoc

    audio_mode = "bo audio (MUTE=True)" if MUTE else \
                 ("giu audio + tang toc" if has_audio else "bo audio (file nguon khong co audio)")

    print(f"\n[3/4] Ghep & tang toc x{SPEED}")
    print(f"      Codec: {CODEC}  Quality: {VIDEO_QUALITY}  Audio: {audio_mode}")
    print(f"      Video filter: {vf}")
    print(f"      Output: {output_path}\n")

    # 4. Chay ffmpeg
    q_flag = get_quality_flags(encoder_type, VIDEO_QUALITY)

    cmd = [
        "ffmpeg", "-y",
        "-f", "concat", "-safe", "0",
        "-i", list_path,
        "-vf", vf,
        "-r", str(out_fps),        # explicit fps cho cac encoder GPU
        "-c:v", codec,
        *q_flag,
        "-movflags", "+faststart",
    ]

    if not MUTE and has_audio:
        cmd += ["-af", build_atempo_chain(SPEED), "-b:a", AUDIO_BITRATE]
    else:
        cmd += ["-an"]

    cmd.append(output_path)

    result = subprocess.run(cmd)

    # Neu encoder GPU vua chon that bai khi chay that (khac voi test 1 frame luc dau),
    # tu dong fallback ve CPU de dam bao script luon chay duoc tren moi may.
    if result.returncode != 0 and encoder_type != "cpu":
        print(f"\n      [!] Encoder {encoder_label} loi khi chay thuc te, fallback ve CPU...")
        cpu_codec = "libx265" if CODEC.upper() == "H265" else "libx264"
        cpu_q_flag = get_quality_flags("cpu", VIDEO_QUALITY)
        cmd = [
            "ffmpeg", "-y",
            "-f", "concat", "-safe", "0",
            "-i", list_path,
            "-vf", vf,
            "-r", str(out_fps),
            "-c:v", cpu_codec,
            *cpu_q_flag,
            "-movflags", "+faststart",
        ]
        if not MUTE and has_audio:
            cmd += ["-af", build_atempo_chain(SPEED), "-b:a", AUDIO_BITRATE]
        else:
            cmd += ["-an"]
        cmd.append(output_path)
        result = subprocess.run(cmd)

    os.unlink(list_path)

    print()
    if result.returncode == 0:
        size_mb = os.path.getsize(output_path) / 1024 / 1024
        print(f"[4/4] Hoan thanh. Output: {output_path} ({size_mb:.1f} MB)")
    else:
        print(f"[4/4] ffmpeg loi (exit code {result.returncode}).")


if __name__ == "__main__":
    main()
