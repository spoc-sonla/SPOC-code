import tkinter as tk
from tkinter import filedialog, messagebox
from PIL import Image, ImageTk
import pymupdf as fitz  # PyMuPDF
import numpy as np
import cv2
import os


class XRayPDFViewer:
    def __init__(self, root):
        self.root = root
        self.root.title("PDF X-Ray Viewer")
        self.root.geometry("1200x800")

        self.pdf = None
        self.pdf_path = None
        self.page_index = 0

        self.zoom = 1.0
        self.render_scale = 2.0

        self.xray_mode = True

        self.original_image = None
        self.display_image = None
        self.preview_photo = None

        # =========================
        # TOP BAR
        # =========================
        toolbar = tk.Frame(root)
        toolbar.pack(fill=tk.X, padx=5, pady=5)

        tk.Button(
            toolbar,
            text="Mở PDF",
            command=self.open_pdf
        ).pack(side=tk.LEFT, padx=3)

        tk.Button(
            toolbar,
            text="◀ Trang trước",
            command=self.prev_page
        ).pack(side=tk.LEFT, padx=3)

        tk.Button(
            toolbar,
            text="Trang sau ▶",
            command=self.next_page
        ).pack(side=tk.LEFT, padx=3)

        self.page_label = tk.Label(
            toolbar,
            text="Chưa mở PDF"
        )
        self.page_label.pack(side=tk.LEFT, padx=15)

        tk.Button(
            toolbar,
            text="− Zoom",
            command=self.zoom_out
        ).pack(side=tk.LEFT, padx=3)

        tk.Button(
            toolbar,
            text="+ Zoom",
            command=self.zoom_in
        ).pack(side=tk.LEFT, padx=3)

        tk.Button(
            toolbar,
            text="100%",
            command=self.reset_zoom
        ).pack(side=tk.LEFT, padx=3)

        self.xray_button = tk.Button(
            toolbar,
            text="X-RAY: ON",
            command=self.toggle_xray
        )
        self.xray_button.pack(side=tk.LEFT, padx=15)

        # =========================
        # X-RAY SETTINGS
        # =========================

        tk.Label(
            toolbar,
            text="Ngưỡng:"
        ).pack(side=tk.LEFT, padx=(15, 2))

        self.threshold_var = tk.IntVar(value=248)

        self.threshold_scale = tk.Scale(
            toolbar,
            from_=200,
            to=254,
            orient=tk.HORIZONTAL,
            variable=self.threshold_var,
            command=lambda x: self.update_preview()
        )
        self.threshold_scale.pack(side=tk.LEFT)

        # =========================
        # MAIN AREA
        # =========================

        main_frame = tk.Frame(root)
        main_frame.pack(fill=tk.BOTH, expand=True)

        self.canvas = tk.Canvas(
            main_frame,
            background="#333333"
        )

        self.v_scroll = tk.Scrollbar(
            main_frame,
            orient=tk.VERTICAL,
            command=self.canvas.yview
        )

        self.h_scroll = tk.Scrollbar(
            main_frame,
            orient=tk.HORIZONTAL,
            command=self.canvas.xview
        )

        self.canvas.configure(
            xscrollcommand=self.h_scroll.set,
            yscrollcommand=self.v_scroll.set
        )

        self.v_scroll.pack(side=tk.RIGHT, fill=tk.Y)
        self.h_scroll.pack(side=tk.BOTTOM, fill=tk.X)
        self.canvas.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)

        # Mouse wheel
        self.canvas.bind(
            "<MouseWheel>",
            self.mouse_wheel
        )

        # Keyboard
        self.root.bind(
            "<Left>",
            lambda e: self.prev_page()
        )

        self.root.bind(
            "<Right>",
            lambda e: self.next_page()
        )

        self.root.bind(
            "<plus>",
            lambda e: self.zoom_in()
        )

        self.root.bind(
            "<minus>",
            lambda e: self.zoom_out()
        )

    # =========================================================
    # OPEN PDF
    # =========================================================

    def open_pdf(self):
        path = filedialog.askopenfilename(
            title="Chọn PDF",
            filetypes=[
                ("PDF files", "*.pdf"),
                ("All files", "*.*")
            ]
        )

        if not path:
            return

        try:
            if self.pdf:
                self.pdf.close()

            self.pdf = fitz.open(path)
            self.pdf_path = path
            self.page_index = 0
            self.zoom = 1.0

            self.load_page()

        except Exception as e:
            messagebox.showerror(
                "Lỗi",
                f"Không thể mở PDF:\n\n{e}"
            )

    # =========================================================
    # RENDER PDF PAGE
    # =========================================================

    def load_page(self):
        if not self.pdf:
            return

        if self.page_index < 0:
            self.page_index = 0

        if self.page_index >= len(self.pdf):
            self.page_index = len(self.pdf) - 1

        page = self.pdf[self.page_index]

        matrix = fitz.Matrix(
            self.render_scale,
            self.render_scale
        )

        pix = page.get_pixmap(
            matrix=matrix,
            alpha=False
        )

        # PyMuPDF RGB
        image = np.frombuffer(
            pix.samples,
            dtype=np.uint8
        )

        image = image.reshape(
            pix.height,
            pix.width,
            3
        )

        self.original_image = image.copy()

        self.update_page_label()
        self.update_preview()

    # =========================================================
    # X-RAY
    # =========================================================

    def apply_xray(self, image):
        if not self.xray_mode:
            return image

        gray = cv2.cvtColor(
            image,
            cv2.COLOR_RGB2GRAY
        )

        threshold = self.threshold_var.get()

        # Các vùng gần trắng
        hidden_mask = (
            (gray >= threshold) &
            (gray <= 254)
        )

        # Màu đỏ
        red_overlay = np.zeros_like(image)
        red_overlay[:] = [255, 0, 0]

        blended = cv2.addWeighted(
            image,
            0.3,
            red_overlay,
            0.7,
            0
        )

        result = image.copy()

        result[hidden_mask] = blended[hidden_mask]

        return result

    # =========================================================
    # UPDATE PREVIEW
    # =========================================================

    def update_preview(self, *_):
        if self.original_image is None:
            return

        image = self.original_image.copy()

        # X-Ray
        image = self.apply_xray(image)

        self.display_image = image

        width = max(
            1,
            int(image.shape[1] * self.zoom)
        )

        height = max(
            1,
            int(image.shape[0] * self.zoom)
        )

        pil_image = Image.fromarray(image)

        preview = pil_image.resize(
            (width, height),
            Image.Resampling.NEAREST
        )

        self.preview_photo = ImageTk.PhotoImage(
            preview
        )

        self.canvas.delete("all")

        self.canvas.create_image(
            0,
            0,
            image=self.preview_photo,
            anchor=tk.NW
        )

        self.canvas.configure(
            scrollregion=(
                0,
                0,
                width,
                height
            )
        )

    # =========================================================
    # PAGE
    # =========================================================

    def prev_page(self):
        if not self.pdf:
            return

        if self.page_index > 0:
            self.page_index -= 1
            self.load_page()

    def next_page(self):
        if not self.pdf:
            return

        if self.page_index < len(self.pdf) - 1:
            self.page_index += 1
            self.load_page()

    def update_page_label(self):
        if self.pdf:
            self.page_label.config(
                text=f"Trang {self.page_index + 1} / {len(self.pdf)}"
            )

    # =========================================================
    # ZOOM
    # =========================================================

    def zoom_in(self):
        self.zoom *= 1.25

        if self.zoom > 10:
            self.zoom = 10

        self.update_preview()

    def zoom_out(self):
        self.zoom /= 1.25

        if self.zoom < 0.1:
            self.zoom = 0.1

        self.update_preview()

    def reset_zoom(self):
        self.zoom = 1.0
        self.update_preview()

    # =========================================================
    # X-RAY TOGGLE
    # =========================================================

    def toggle_xray(self):
        self.xray_mode = not self.xray_mode

        if self.xray_mode:
            self.xray_button.config(
                text="X-RAY: ON"
            )
        else:
            self.xray_button.config(
                text="X-RAY: OFF"
            )

        self.update_preview()

    # =========================================================
    # MOUSE WHEEL
    # =========================================================

    def mouse_wheel(self, event):
        self.canvas.yview_scroll(
            int(-1 * (event.delta / 120)),
            "units"
        )


# =============================================================
# MAIN
# =============================================================

if __name__ == "__main__":
    root = tk.Tk()

    app = XRayPDFViewer(root)

    root.mainloop()