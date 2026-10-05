import os
import tkinter as tk
from tkinter import filedialog, messagebox, ttk
from pypdf import PdfReader, PdfWriter


class PDFSplitterApp:

    def __init__(self, root):
        self.root = root
        self.root.title("Công Cụ Tách PDF Hàng Loạt")
        self.root.geometry("560x430")
        self.root.resizable(False, False)

        # Trạng thái
        self.mode = "file"  # 'file' hoặc 'folder'
        self.selected_path = ""
        self.pdf_files = []

        self.setup_ui()

    def setup_ui(self):
        # 1. Chọn chế độ & Nguồn
        frame_source = ttk.LabelFrame(
            self.root, text=" 1. Chọn Nguồn PDF ", padding=10
        )
        frame_source.pack(fill="x", padx=15, pady=10)

        # Radio button chọn chế độ
        self.mode_var = tk.StringVar(value="file")
        rb_file = ttk.Radiobutton(
            frame_source,
            text="Tách 1 File",
            value="file",
            variable=self.mode_var,
            command=self.on_mode_change,
        )
        rb_file.grid(row=0, column=0, sticky="w", padx=5)

        rb_folder = ttk.Radiobutton(
            frame_source,
            text="Tách cả Thư Mục (Batch)",
            value="folder",
            variable=self.mode_var,
            command=self.on_mode_change,
        )
        rb_folder.grid(row=0, column=1, sticky="w", padx=5)

        # Nút duyệt
        self.btn_browse = ttk.Button(
            frame_source, text="Chọn File...", command=self.browse_source
        )
        self.btn_browse.grid(row=1, column=0, pady=10, padx=5, sticky="w")

        self.lbl_path = ttk.Label(
            frame_source, text="Chưa chọn đối tượng nào", foreground="gray"
        )
        self.lbl_path.grid(row=1, column=1, padx=5, sticky="w")

        # 2. Cấu Hình Tách Trang
        frame_config = ttk.LabelFrame(
            self.root, text=" 2. Cấu Hình Tách Trang ", padding=10
        )
        frame_config.pack(fill="x", padx=15, pady=5)

        # Số file/trang tìm thấy
        ttk.Label(frame_config, text="Thông tin tìm thấy:").grid(
            row=0, column=0, sticky="w", pady=5
        )
        self.lbl_info = ttk.Label(
            frame_config, text="0 file PDF", font=("Arial", 9, "bold")
        )
        self.lbl_info.grid(row=0, column=1, sticky="w", padx=10, pady=5)

        # Nhập số trang/file
        ttk.Label(frame_config, text="Số trang / 1 file nhỏ:").grid(
            row=1, column=0, sticky="w", pady=5
        )
        self.spin_pages = ttk.Spinbox(
            frame_config, from_=1, to=500, width=8, font=("Arial", 10)
        )
        self.spin_pages.set(6)  # Mặc định là 6 trang
        self.spin_pages.grid(row=1, column=1, sticky="w", padx=10, pady=5)

        # 3. Tiến Trình Execution
        self.lbl_progress = ttk.Label(
            self.root, text="Tiến trình:", font=("Arial", 9)
        )
        self.lbl_progress.pack(anchor="w", padx=15, pady=(5, 0))

        self.progress = ttk.Progressbar(self.root, mode="determinate")
        self.progress.pack(fill="x", padx=15, pady=5)

        # Nút bấm thực thi
        self.btn_split = ttk.Button(
            self.root,
            text="BẮT ĐẦU TÁCH PDF",
            state="disabled",
            command=self.start_split,
        )
        self.btn_split.pack(pady=10, ipadx=20, ipady=5)

        # Status Bar
        self.lbl_status = ttk.Label(
            self.root, text="Sẵn sàng", font=("Arial", 9, "italic")
        )
        self.lbl_status.pack(side="bottom", fill="x", padx=10, pady=5)

    def on_mode_change(self):
        self.mode = self.mode_var.get()
        self.selected_path = ""
        self.pdf_files = []
        self.lbl_path.config(
            text="Chưa chọn đối tượng nào", foreground="gray"
        )
        self.lbl_info.config(text="0 file PDF")
        self.btn_split.config(state="disabled")

        if self.mode == "file":
            self.btn_browse.config(text="Chọn File...")
        else:
            self.btn_browse.config(text="Chọn Thư Mục...")

    def browse_source(self):
        if self.mode == "file":
            filename = filedialog.askopenfilename(
                title="Chọn file PDF", filetypes=[("PDF Files", "*.pdf")]
            )
            if filename:
                self.selected_path = filename
                self.pdf_files = [filename]
                try:
                    reader = PdfReader(filename)
                    total_p = len(reader.pages)
                    self.lbl_path.config(
                        text=os.path.basename(filename), foreground="black"
                    )
                    self.lbl_info.config(text=f"1 file ({total_p} trang)")
                    self.btn_split.config(state="normal")
                except Exception as e:
                    messagebox.showerror(
                        "Lỗi", f"Không đọc được file PDF:\n{str(e)}"
                    )
        else:
            folder = filedialog.askdirectory(title="Chọn Thư Mục Chứa File PDF")
            if folder:
                self.selected_path = folder
                # Tìm tất cả file .pdf trong thư mục
                self.pdf_files = [
                    os.path.join(folder, f)
                    for f in os.listdir(folder)
                    if f.lower().endswith(".pdf")
                ]

                count = len(self.pdf_files)
                if count == 0:
                    messagebox.showwarning(
                        "Cảnh báo", "Thư mục chọn không chứa file PDF nào!"
                    )
                    self.btn_split.config(state="disabled")
                    return

                self.lbl_path.config(
                    text=os.path.basename(folder) or folder, foreground="black"
                )
                self.lbl_info.config(text=f"Tìm thấy {count} file PDF")
                self.btn_split.config(state="normal")

    def split_single_pdf(
        self, file_path, pages_per_file, output_dir, subfolder=False
    ):
        """Hàm xử lý tách cho 1 file PDF"""
        reader = PdfReader(file_path)
        total = len(reader.pages)
        base_name = os.path.splitext(os.path.basename(file_path))[0]

        # Nếu tách thư mục, gom kết quả từng file vào thư mục con riêng cho gọn
        target_dir = (
            os.path.join(output_dir, base_name) if subfolder else output_dir
        )
        os.makedirs(target_dir, exist_ok=True)

        for idx, start_page in enumerate(
            range(0, total, pages_per_file), start=1
        ):
            writer = PdfWriter()
            end_page = min(start_page + pages_per_file, total)

            for p in range(start_page, end_page):
                writer.add_page(reader.pages[p])

            out_filename = (
                f"{base_name}_part_{idx}_trang_{start_page + 1}-{end_page}.pdf"
            )
            out_path = os.path.join(target_dir, out_filename)

            with open(out_path, "wb") as f:
                writer.write(f)

    def start_split(self):
        try:
            pages_per_file = int(self.spin_pages.get())
            if pages_per_file <= 0:
                raise ValueError()
        except ValueError:
            messagebox.showwarning("Lỗi", "Số trang phải là một số nguyên > 0!")
            return

        # Chọn thư mục đầu ra
        output_dir = filedialog.askdirectory(title="Chọn thư mục lưu kết quả")
        if not output_dir:
            return

        total_files = len(self.pdf_files)
        self.progress["maximum"] = total_files
        self.progress["value"] = 0

        success_count = 0
        is_batch = self.mode == "folder"

        for idx, pdf_path in enumerate(self.pdf_files, start=1):
            try:
                filename = os.path.basename(pdf_path)
                self.lbl_status.config(
                    text=f"Đang xử lý [{idx}/{total_files}]: {filename}...",
                    foreground="blue",
                )
                self.root.update_idletasks()

                self.split_single_pdf(
                    pdf_path,
                    pages_per_file,
                    output_dir,
                    subfolder=is_batch,
                )
                success_count += 1
            except Exception as e:
                print(f"Lỗi khi xử lý {pdf_path}: {e}")

            self.progress["value"] = idx
            self.root.update_idletasks()

        self.lbl_status.config(
            text="Đã hoàn thành tất cả!", foreground="green"
        )
        messagebox.showinfo(
            "Thành công",
            f"Đã xử lý xong {success_count}/{total_files} file PDF!\nLưu tại: {output_dir}",
        )


if __name__ == "__main__":
    root = tk.Tk()
    app = PDFSplitterApp(root)
    root.mainloop()