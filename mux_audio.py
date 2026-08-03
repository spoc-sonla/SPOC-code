import subprocess
import glob
import sys

def find_file(basename):
    """Tìm file theo tên gốc'"""
    matches = glob.glob(basename + ".*")
    if not matches:
        print(f"Không tìm thấy file nào tên '{basename}.*'")
        sys.exit(1)
    if len(matches) > 1:
        print(f"Cảnh báo: có nhiều file khớp {matches}, dùng file đầu tiên: {matches[0]}")
    return matches[0]


def run_ffmpeg(cmd):
    """Chạy lệnh ffmpeg, trả về (thành công: bool, stderr: str)"""
    result = subprocess.run(cmd, capture_output=True, text=True)
    return result.returncode == 0, result.stderr


def mux_audio_into_video(video_path, audio_path, output_path="output.mp4"):
    base_cmd = [
        "ffmpeg",
        "-y",
        "-i", video_path,
        "-i", audio_path,
        "-map", "0:v:0",
        "-map", "1:a:0",
        "-shortest",
    ]

    # --- Lần 1: thử full lossless ---
    cmd_copy = base_cmd + ["-c:v", "copy", "-c:a", "copy", output_path]
    print("Đang thử ghép lossless...")
    print(">", " ".join(cmd_copy))
    ok, err = run_ffmpeg(cmd_copy)

    if ok:
        print(f"Thành công! File output: {output_path}")
        return

    print("Copy audio thất bại (codec không tương thích với container output).")
    print("Chi tiết lỗi ffmpeg:\n", err.strip()[-800:])
    print("\nTự động fallback...")

    # --- Lần 2: fallback, audio encode lại ---
    cmd_fallback = base_cmd + ["-c:v", "copy", "-c:a", "aac", "-b:a", "192k", output_path]
    print(">", " ".join(cmd_fallback))
    ok2, err2 = run_ffmpeg(cmd_fallback)

    if ok2:
        print(f"Thành công! File output: {output_path}")
    else:
        print("Vẫn thất bại. Chi tiết lỗi ffmpeg:\n", err2.strip()[-1500:])
        sys.exit(1)


if __name__ == "__main__":
    video_file = find_file("video")
    audio_file = find_file("audio")

    print(f"Video (không tiếng): {video_file}")
    print(f"Audio/Video nguồn âm thanh: {audio_file}")
    print()

    mux_audio_into_video(video_file, audio_file, "output.mp4")
