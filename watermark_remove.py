import io
import os
import threading
from collections import OrderedDict
import tkinter as tk
from tkinter import filedialog, messagebox, ttk

import cv2
import numpy as np
import pymupdf
from PIL import Image, ImageTk, ImageEnhance
from PIL.PngImagePlugin import PngInfo

# ============================================================
# CONFIG
# ============================================================
INTERNAL_SCALE = 2.0          
LAB_TOLERANCE_DEFAULT = 20     # Ngưỡng khoảng cách màu LAB (Thay thế cho RGB)
BLEND_BOOST_DEFAULT = 1.0      # Hệ số bù sáng cho nét chữ

MIN_BRUSH, MAX_BRUSH = 1, 101
ZOOM_STEP = 1.25
MIN_ZOOM, MAX_ZOOM = 0.10, 10.0
DEFAULT_ZOOM = 0.4   # độ phóng đại trang mặc định

UNDO_LIMIT = 10

# --- Cấu hình hiển thị PDF dạng cuộn ảo ---
PAGE_GAP = 18            # khoảng cách giữa các trang (px màn hình)
VIEWPORT_BUFFER_PAGES = 1  # số trang đệm thêm ở trên/dưới vùng nhìn thấy
RENDER_CACHE_MAX_PAGES = 4  # số trang tối đa đã render trong bộ nhớ cùng lúc

# ============================================================
# PDF -> NUMPY (Giữ nguyên RGB)
# ============================================================
def render_page(page: "pymupdf.Page") -> np.ndarray:
    pix = page.get_pixmap(matrix=pymupdf.Matrix(INTERNAL_SCALE, INTERNAL_SCALE), alpha=False)
    if pix.n != 3 or pix.colorspace is None or pix.colorspace.name != "DeviceRGB":
        pix = pymupdf.Pixmap(pymupdf.csRGB, pix)
    arr = np.frombuffer(pix.samples, dtype=np.uint8)
    return arr.reshape(pix.height, pix.width, 3).copy()

def detect_paper_color(image: np.ndarray) -> np.ndarray:
    h, w = image.shape[:2]
    border_px = max(2, min(h, w) // 100)
    border = np.concatenate([
        image[:border_px, :].reshape(-1, 3),
        image[-border_px:, :].reshape(-1, 3),
        image[:, :border_px].reshape(-1, 3),
        image[:, -border_px:].reshape(-1, 3),
    ])
    if border.size == 0:
        return np.array([255, 255, 255], dtype=np.float64)

    border_u32 = border.astype(np.uint32)
    encoded = (border_u32[:, 0] << 16) | (border_u32[:, 1] << 8) | border_u32[:, 2]
    counts = np.bincount(encoded)
    most_common = np.argmax(counts)
    r = (most_common >> 16) & 0xFF
    g = (most_common >> 8) & 0xFF
    b = most_common & 0xFF
    return np.array([r, g, b], dtype=np.float64)

# ============================================================
# LÕI THUẬT TOÁN TOÁN HỌC CHUYÊN SÂU (100% Xóa Watermark Phức tạp)
# ============================================================
def process_watermark_advanced(image_a, image_b, lab_b, lab_tolerance, boost_factor):
    h, w = image_a.shape[:2]
    bh, bw = image_b.shape[:2]
    y1, x1 = min(h, bh), min(w, bw)

    result = image_a.copy()
    if y1 <= 0 or x1 <= 0:
        return result, np.zeros((h, w), dtype=bool)

    # Cắt vùng tương đương
    a = image_a[:y1, :x1]
    b = image_b[:y1, :x1]

    # 1. Đảo ngược chế độ hòa trộn
    # Công thức: Chữ_gốc = (Ảnh_A * 255) / Ảnh_B
    # Giúp khôi phục nét chữ bên dưới watermark không bị mờ
    a_f = a.astype(np.float32)
    b_f = b.astype(np.float32)
    
    B_FLOOR = 8.0
    b_safe = np.where(b_f < B_FLOOR, B_FLOOR, b_f)
    recovered_text = (a_f * 255.0) / b_safe
    
    # Bù sáng nhẹ nếu watermark làm nét chữ bị nhạt
    recovered_text = recovered_text * boost_factor
    recovered_text = np.clip(recovered_text, 0, 255)

    # 2. Chuyển sang không gian màu LAB để đo khoảng cách
    lab_a = cv2.cvtColor(a, cv2.COLOR_RGB2LAB).astype(np.float32)
    lab_b_crop = lab_b[:y1, :x1]

    # Tính khoảng cách hình học Euclidean giữa 2 màu trong không gian LAB
    delta_lab = np.sqrt(np.sum((lab_a - lab_b_crop) ** 2, axis=2))

    # 3. Tạo mặt nạ chuyển dải mềm (Soft Mask) thay vì cắt cứng (Hard Threshold)
    # Nếu delta_lab nhỏ hơn nửa tolerance -> 100% là watermark -> mask = 0
    # Nếu delta_lab lớn hơn tolerance -> 100% là chữ/hình -> mask = 1
    # Khoảng giữa sẽ được làm mờ
    soft_mask = (delta_lab - (lab_tolerance * 0.5)) / (lab_tolerance * 0.5 + 1e-6)
    soft_mask = np.clip(soft_mask, 0.0, 1.0)
    
    # Mở rộng mask ra 3 kênh màu (R, G, B)
    soft_mask_3c = np.repeat(soft_mask[:, :, np.newaxis], 3, axis=2)

    # Lấy màu giấy tự nhiên
    paper_color = detect_paper_color(a).astype(np.float32)

    # 4. Lắp ghép Toán học: 
    # Kết quả = Nền giấy * (Phần thuộc Watermark) + Chữ đã khôi phục * (Phần thuộc nét chữ)
    final_blended = paper_color * (1.0 - soft_mask_3c) + recovered_text * soft_mask_3c
    
    result[:y1, :x1] = final_blended.astype(np.uint8)

    # Trả về mask nhị phân để vẽ lên giao diện cho người dùng xem vùng đã xử lý
    binary_mask_ui = np.zeros((h, w), dtype=bool)
    binary_mask_ui[:y1, :x1] = soft_mask < 0.99

    return result, binary_mask_ui

# ============================================================
# PIL / PDF helpers
# ============================================================
def np_to_pil(arr: np.ndarray) -> Image.Image:
    return Image.fromarray(np.asarray(arr, dtype=np.uint8), "RGB")

def image_to_pdf_page(pdf: "pymupdf.Document", image: np.ndarray, width_pt: float, height_pt: float):
    buffer = io.BytesIO()
    np_to_pil(image).save(buffer, format="PNG", pnginfo=PngInfo())
    page = pdf.new_page(width=width_pt, height=height_pt)
    page.insert_image(page.rect, stream=buffer.getvalue())

# ============================================================
# GIAO DIỆN (UI) - THIẾT KẾ CHUYÊN NGHIỆP, GIỮ NGUYÊN THUẬT TOÁN
# ============================================================

# --- Bảng màu (Design tokens) ---
COLOR_BG_APP     = "#F4F5F7"   # Nền tổng thể
COLOR_SIDEBAR    = "#FFFFFF"   # Nền sidebar
COLOR_SIDEBAR_BD = "#E3E5E8"   # Viền sidebar
COLOR_CANVAS_BG  = "#E9EAEC"   # Nền khu preview
COLOR_STATUSBAR  = "#F8F9FA"   # Nền thanh trạng thái dưới
COLOR_PRIMARY     = "#009FA4"   # Nền nút phân tích
COLOR_PRIMARY_HV  = "#00A046"   # Nền nút phân tích hover
COLOR_PRIMARY_TXT = "#FFFF26"   # Chữ trên nút phân tích
COLOR_ACCENT_OK  = "#15803D"   # Xanh lá đậm hơn (thành công) - đồng bộ độ đậm với primary
COLOR_ACCENT_AMB = "#B45309"   # Hổ phách
COLOR_TEXT_MAIN  = "#1A1F29"
COLOR_TEXT_SUB   = "#5B6472"
COLOR_BORDER     = "#D6D8DC"
COLOR_TOOL_ACTIVE = "#DBEAFE"
COLOR_RESIZE_HANDLE = "#C7CAD1"
COLOR_RESIZE_HANDLE_HOVER = "#94A3B8"

FONT_FAMILY = "Segoe UI"       # Hỗ trợ tiếng Việt tốt, hiện đại. Fallback tự động nếu hệ không có.
FONT_MONO   = "Consolas"

FS_SECTION_TITLE = 13   # tiêu đề khối trong sidebar
FS_LABEL         = 13   # nhãn (Độ nhạy LAB, Kích thước cọ...)
FS_BUTTON        = 14   # chữ trên nút bấm thường
FS_BUTTON_PRIMARY = 15  # chữ trên nút Phân tích
FS_HINT          = 12   # chú thích nhỏ màu xám
FS_FILE_LABEL    = 12   # tên file A/B đã chọn
FS_STATUSBAR     = 13   # thanh trạng thái dưới cùng
FS_SPINBOX       = 13   # ô nhập số
FS_TITLE         = 14   # tiêu đề "CÔNG CỤ" trong sidebar

def _mkfont(size, weight="normal", family=FONT_FAMILY):
    return (family, size, weight)


class CollapsibleSidebar(tk.Frame):
    """Sidebar bên trái"""
    EXPANDED_WIDTH = 340
    COLLAPSED_WIDTH = 44
    MIN_WIDTH = 260
    MAX_WIDTH = 560

    def __init__(self, master, **kwargs):
        super().__init__(master, bg=COLOR_SIDEBAR, width=self.EXPANDED_WIDTH,
                          highlightthickness=1, highlightbackground=COLOR_SIDEBAR_BD, **kwargs)
        self.pack_propagate(False)
        self.collapsed = False
        self._expanded_width = self.EXPANDED_WIDTH  # nhớ lại bề rộng đã kéo giãn khi mở lại

        # Thanh tiêu đề chứa nút thu/mở
        header = tk.Frame(self, bg=COLOR_SIDEBAR, height=48)
        header.pack(fill=tk.X, side=tk.TOP)
        header.pack_propagate(False)

        self.title_label = tk.Label(header, text="CÔNG CỤ", bg=COLOR_SIDEBAR, fg=COLOR_TEXT_SUB,
                                     font=_mkfont(FS_TITLE, "bold"))
        self.title_label.pack(side=tk.LEFT, padx=16)

        self.toggle_btn = tk.Button(header, text="‹", font=_mkfont(16, "bold"), width=2,
                                     bg=COLOR_SIDEBAR, fg=COLOR_TEXT_MAIN, bd=0,
                                     activebackground=COLOR_TOOL_ACTIVE, cursor="hand2",
                                     command=self.toggle)
        self.toggle_btn.pack(side=tk.RIGHT, padx=8)

        # Vùng nội dung cuộn được (chứa các panel công cụ)
        self.body = tk.Frame(self, bg=COLOR_SIDEBAR)
        self.body.pack(fill=tk.BOTH, expand=True)

        # --- Handle kéo-giãn bề rộng, đặt ở cạnh phải sidebar ---
        self.resize_handle = tk.Frame(self, bg=COLOR_RESIZE_HANDLE, width=4, cursor="sb_h_double_arrow")
        self.resize_handle.place(relx=1.0, rely=0, relheight=1.0, anchor="ne")
        self.resize_handle.bind("<Enter>", lambda e: self.resize_handle.config(bg=COLOR_RESIZE_HANDLE_HOVER))
        self.resize_handle.bind("<Leave>", lambda e: self.resize_handle.config(bg=COLOR_RESIZE_HANDLE))
        self.resize_handle.bind("<Button-1>", self._start_resize)
        self.resize_handle.bind("<B1-Motion>", self._do_resize)

    def _start_resize(self, event):
        if self.collapsed:
            return
        self._resize_start_x = event.x_root
        self._resize_start_width = self.winfo_width()

    def _do_resize(self, event):
        if self.collapsed:
            return
        delta = event.x_root - self._resize_start_x
        new_width = max(self.MIN_WIDTH, min(self.MAX_WIDTH, self._resize_start_width + delta))
        self._expanded_width = new_width
        self.configure(width=new_width)

    def toggle(self):
        self.collapsed = not self.collapsed
        if self.collapsed:
            self.body.pack_forget()
            self.title_label.pack_forget()
            self.toggle_btn.config(text="›")
            self.resize_handle.place_forget()
            self.configure(width=self.COLLAPSED_WIDTH)
        else:
            self.configure(width=self._expanded_width)
            self.title_label.pack(side=tk.LEFT, padx=16)
            self.body.pack(fill=tk.BOTH, expand=True)
            self.toggle_btn.config(text="‹")
            self.resize_handle.place(relx=1.0, rely=0, relheight=1.0, anchor="ne")


class SectionFrame(tk.Frame):
    """Một khối nội dung trong sidebar, có tiêu đề nhỏ phía trên."""
    def __init__(self, master, title, **kwargs):
        super().__init__(master, bg=COLOR_SIDEBAR, **kwargs)
        tk.Label(self, text=title.upper(), bg=COLOR_SIDEBAR, fg=COLOR_TEXT_SUB,
                 font=_mkfont(FS_SECTION_TITLE, "bold")).pack(anchor="w", padx=18, pady=(16, 8))
        self.content = tk.Frame(self, bg=COLOR_SIDEBAR)
        self.content.pack(fill=tk.X, padx=18)


def styled_button(master, text, command, kind="default", height=1, font_size=None):
    """Nút bấm được style thống nhất (dùng tk.Button thuần để kiểm soát màu chính xác trên mọi hệ)."""
    palette = {
        "primary": dict(bg=COLOR_PRIMARY, fg=COLOR_PRIMARY_TXT, active_bg=COLOR_PRIMARY_HV, active_fg=COLOR_PRIMARY_TXT),
        "success": dict(bg="#DCFCE7", fg=COLOR_ACCENT_OK, active_bg="#BBF7D0", active_fg=COLOR_ACCENT_OK),
        "default": dict(bg="#F1F2F4", fg=COLOR_TEXT_MAIN, active_bg="#E4E6E9", active_fg=COLOR_TEXT_MAIN),
        "amber":   dict(bg="#FEF0DA", fg=COLOR_ACCENT_AMB, active_bg="#FBE3BB", active_fg=COLOR_ACCENT_AMB),
    }[kind]
    if font_size is None:
        font_size = FS_BUTTON_PRIMARY if kind == "primary" else FS_BUTTON
    btn = tk.Button(
        master, text=text, command=command,
        bg=palette["bg"], fg=palette["fg"],
        activebackground=palette["active_bg"], activeforeground=palette["active_fg"],
        disabledforeground="#9CA3AF",
        relief="flat", bd=0, cursor="hand2",
        font=_mkfont(font_size, "bold" if kind == "primary" else "normal"),
        padx=12, pady=10 if height == 1 else 5, anchor="center", justify="center",
        highlightthickness=0,
    )
    return btn


class App:
    def __init__(self, root: tk.Tk):
        self.root = root
        self.root.title("Trình Xóa Watermark tài liệu VBC — SPOC APP")
        self.root.geometry("1920x1080+0+0")
        self.root.configure(bg=COLOR_BG_APP)
        self.root.iconbitmap("icon.ico")
        self._maximize_on_startup()
        try:
            self.root.tk.call("tk", "scaling", 1.15)
        except Exception:
            pass

        self.pdf_a = None
        self.pdf_b = None
        self.b_page_image = None
        self.result_pages = []
        self.original_pages = []
        self.page_sizes_pt = []
        self.removable_masks = []
        self.current_page = 0
        self.zoom = DEFAULT_ZOOM
        self.preview_photo = None
        self.tool = "pointer"
        self.brush_size = 10
        self.paint_color = (255, 255, 255)
        self.undo_stack = []
        self.redo_stack = []
        self.processing = False

        # --- Hệ thống hiển thị PDF dạng cuộn ảo (viewport virtualization) ---
        self._page_layout = []
        self._page_rect_items = {}   # {page_idx: canvas_rect_id}
        self._page_image_items = {}  # {page_idx: canvas_image_id}
        self._render_cache = OrderedDict()
        self._layout_zoom = None     # zoom mà _page_layout hiện tại được tính theo
        self._scroll_job = None      # id của after() đang chờ để debounce sự kiện cuộn/resize

        # Độ nét CHỈ áp dụng khi hiển thị preview trên canvas
        self.preview_sharpness = 1.0 
        self._sharpness_job = None    # id của after() đang chờ để debounce slider độ nét
        self._brush_cursor_id = None  # canvas item id của khung viền đỏ xem trước cọ tẩy
        self._last_mouse_canvas_pos = None  # (canvas_x, canvas_y) lần cuối ghi nhận, để vẽ lại viền khi đổi size cọ mà chuột không di chuyển

        self.build_ui()

    def _maximize_on_startup(self):
        """Mở app ở trạng thái cửa sổ to hết cỡ (maximize) ngay từ đầu"""
        # Cách 1: 'zoomed'
        try:
            self.root.state("zoomed")
            return
        except tk.TclError:
            pass
        # Cách 2: thuộc tính '-zoomed'
        try:
            self.root.attributes("-zoomed", True)
            return
        except tk.TclError:
            pass
        # Cách 3: fallback
        try:
            self.root.update_idletasks()
            w = self.root.winfo_screenwidth()
            h = self.root.winfo_screenheight()
            self.root.geometry(f"{w}x{h}+0+0")
        except Exception:
            pass  # giữ nguyên geometry dự phòng

    # ------------------------------------------------------------------
    # XÂY DỰNG GIAO DIỆN
    # ------------------------------------------------------------------
    def build_ui(self):
        root_container = tk.Frame(self.root, bg=COLOR_BG_APP)
        root_container.pack(fill=tk.BOTH, expand=True)

        # ================= SIDEBAR TRÁI (thu/mở được) =================
        self.sidebar = CollapsibleSidebar(root_container)
        self.sidebar.pack(side=tk.LEFT, fill=tk.Y)
        self._build_sidebar_content(self.sidebar.body)

        # ================= KHU VỰC BÊN PHẢI =================
        right = tk.Frame(root_container, bg=COLOR_BG_APP)
        right.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)

        # ---- Khu preview PDF (cuộn liên tục nhiều trang) ----
        preview_wrap = tk.Frame(right, bg=COLOR_CANVAS_BG, highlightthickness=0)
        preview_wrap.pack(fill=tk.BOTH, expand=True)

        self.v_scroll = tk.Scrollbar(preview_wrap, orient=tk.VERTICAL)
        self.v_scroll.pack(side=tk.RIGHT, fill=tk.Y)
        self.h_scroll = tk.Scrollbar(preview_wrap, orient=tk.HORIZONTAL)
        self.h_scroll.pack(side=tk.BOTTOM, fill=tk.X)

        self.canvas = tk.Canvas(preview_wrap, bg=COLOR_CANVAS_BG, highlightthickness=0,
                                 xscrollcommand=self.h_scroll.set)
        self.canvas.pack(fill=tk.BOTH, expand=True)

        def _on_yscroll(*args):
            self.v_scroll.set(*args)
            self.on_canvas_scroll_or_resize()
        self.canvas.configure(yscrollcommand=_on_yscroll)
        self.v_scroll.config(command=self.canvas.yview)
        self.h_scroll.config(command=self.canvas.xview)

        self.canvas.bind("<Motion>", self.on_mouse_move)
        self.canvas.bind("<Leave>", self.on_canvas_leave)
        self.canvas.bind("<Button-1>", self.on_mouse_down)
        self.canvas.bind("<B1-Motion>", self.on_mouse_drag)
        self.canvas.bind("<ButtonRelease-1>", self.on_mouse_up)
        # Cuộn chuột thường = cuộn trang (dọc). Ctrl+cuộn = zoom (giống Word/PDF reader).
        self.canvas.bind("<MouseWheel>", self.on_mousewheel_scroll)
        self.canvas.bind("<Control-MouseWheel>", self.mouse_zoom)
        self.canvas.bind("<Button-4>", self.on_mousewheel_scroll)   # Linux scroll up
        self.canvas.bind("<Button-5>", self.on_mousewheel_scroll)   # Linux scroll down
        # Resize cửa sổ
        self.canvas.bind("<Configure>", self.on_canvas_scroll_or_resize)

        self.root.bind("<Control-z>", lambda e: self.undo())
        self.root.bind("<Control-y>", lambda e: self.redo())

        # ---- Thanh trạng thái dưới cùng ----
        self._build_statusbar(right)

    # ---------------- SIDEBAR: nội dung ----------------
    def _build_sidebar_content(self, body):
        canvas = tk.Canvas(body, bg=COLOR_SIDEBAR, highlightthickness=0)
        vs = tk.Scrollbar(body, orient=tk.VERTICAL, command=canvas.yview)
        inner = tk.Frame(canvas, bg=COLOR_SIDEBAR)
        inner_window = canvas.create_window((0, 0), window=inner, anchor="nw")
        inner.bind("<Configure>", lambda e: canvas.configure(scrollregion=canvas.bbox("all")))
        canvas.bind("<Configure>", lambda e: canvas.itemconfig(inner_window, width=e.width))
        canvas.configure(yscrollcommand=vs.set)
        canvas.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)
        vs.pack(side=tk.RIGHT, fill=tk.Y)

        # --- Cuộn bằng lăn chuột trong sidebar ---
        def _sidebar_mousewheel(event):
            delta = event.delta if hasattr(event, "delta") and event.delta else (120 if getattr(event, "num", 5) == 4 else -120)
            canvas.yview_scroll(-1 if delta > 0 else 1, "units")
        def _bind_wheel_recursive(widget):
            widget.bind("<MouseWheel>", _sidebar_mousewheel)
            widget.bind("<Button-4>", _sidebar_mousewheel)
            widget.bind("<Button-5>", _sidebar_mousewheel)
            for child in widget.winfo_children():
                _bind_wheel_recursive(child)

        # --- 1. Tệp PDF ---
        sec_file = SectionFrame(inner, "Tệp PDF")
        sec_file.pack(fill=tk.X)
        styled_button(sec_file.content, "📄  Chọn PDF cần xóa", self.choose_a, kind="default").pack(fill=tk.X, pady=4)
        styled_button(sec_file.content, "🖇  Chọn PDF mẫu watermark", self.choose_b, kind="default").pack(fill=tk.X, pady=4)

        self.label_a = tk.Label(sec_file.content, text="In: chưa chọn", bg=COLOR_SIDEBAR, fg=COLOR_TEXT_SUB,
                                 font=_mkfont(FS_FILE_LABEL), anchor="w", justify="left", wraplength=280)
        self.label_a.pack(fill=tk.X, pady=(8, 3))
        self.label_b = tk.Label(sec_file.content, text="Co: chưa chọn", bg=COLOR_SIDEBAR, fg=COLOR_TEXT_SUB,
                                 font=_mkfont(FS_FILE_LABEL), anchor="w", justify="left", wraplength=280)
        self.label_b.pack(fill=tk.X, pady=(3, 6))

        # --- 2. Xử lý ---
        sec_run = SectionFrame(inner, "Xử lý")
        sec_run.pack(fill=tk.X)
        self.analyze_button = styled_button(sec_run.content, "DO IT!",
                                             self.start_analysis, kind="primary")
        self.analyze_button.config(state=tk.DISABLED)
        self.analyze_button.pack(fill=tk.X, pady=4, ipady=6)

        self.progress = ttk.Progressbar(sec_run.content, mode="determinate")
        self.progress.pack(fill=tk.X, pady=(10, 6))

        # --- 3. Xuất kết quả ---
        sec_export = SectionFrame(inner, "Xuất kết quả")
        sec_export.pack(fill=tk.X)
        row = tk.Frame(sec_export.content, bg=COLOR_SIDEBAR)
        row.pack(fill=tk.X, pady=4)
        styled_button(row, "⬇ PDF", self.export_pdf, kind="success").pack(side=tk.LEFT, fill=tk.X, expand=True, padx=(0, 5))
        styled_button(row, "⬇ PNG", self.export_png, kind="success").pack(side=tk.LEFT, fill=tk.X, expand=True)

        # --- 4. Thiết lập thuật toán LAB ---
        sec_lab = SectionFrame(inner, "Thiết lập thuật toán LAB")
        sec_lab.pack(fill=tk.X)

        self.lab_var = tk.DoubleVar(value=LAB_TOLERANCE_DEFAULT)
        self.boost_var = tk.DoubleVar(value=BLEND_BOOST_DEFAULT)

        tk.Label(sec_lab.content, text="Độ nhạy khoảng cách LAB (5–30)", bg=COLOR_SIDEBAR,
                 fg=COLOR_TEXT_MAIN, font=_mkfont(FS_LABEL)).pack(anchor="w", pady=(6, 3))
        tk.Spinbox(sec_lab.content, from_=1.0, to=100.0, increment=1.0, width=8,
                   textvariable=self.lab_var, font=_mkfont(FS_SPINBOX), relief="flat",
                   highlightthickness=1, highlightbackground=COLOR_BORDER).pack(anchor="w", ipady=5)

        tk.Label(sec_lab.content, text="Hệ số nét chữ (1.0 – 2.0)", bg=COLOR_SIDEBAR,
                 fg=COLOR_TEXT_MAIN, font=_mkfont(FS_LABEL)).pack(anchor="w", pady=(12, 3))
        tk.Spinbox(sec_lab.content, from_=0.5, to=3.0, increment=0.1, width=8,
                   textvariable=self.boost_var, font=_mkfont(FS_SPINBOX), relief="flat",
                   highlightthickness=1, highlightbackground=COLOR_BORDER).pack(anchor="w", ipady=5)

        tk.Label(sec_lab.content,
                 text="Tăng độ nhạy LAB nếu viền watermark chưa hết.",
                 bg=COLOR_SIDEBAR, fg=COLOR_TEXT_SUB, font=_mkfont(FS_HINT), justify="left",
                 anchor="w").pack(anchor="w", pady=(10, 6))

        # --- 5. Công cụ thủ công ---
        sec_tools = SectionFrame(inner, "Công cụ thủ công")
        sec_tools.pack(fill=tk.X, pady=(0, 12))

        grid = tk.Frame(sec_tools.content, bg=COLOR_SIDEBAR)
        grid.pack(fill=tk.X, pady=4)
        grid.columnconfigure((0, 1), weight=1)

        self.tool_buttons = {}
        tool_defs = [
            ("pointer", "👆  Xem pixel"),
            ("eyedropper", "💧  Hút màu"),
            ("pencil", "✏  Bút vẽ"),
            ("eraser", "⬜  Tẩy viền"),
        ]
        for idx, (key, label) in enumerate(tool_defs):
            b = styled_button(grid, label, lambda k=key: self.set_tool(k), kind="default")
            b.grid(row=idx // 2, column=idx % 2, sticky="ew", padx=4, pady=4)
            self.tool_buttons[key] = b
        self._refresh_tool_buttons()

        brush_row = tk.Frame(sec_tools.content, bg=COLOR_SIDEBAR)
        brush_row.pack(fill=tk.X, pady=(12, 3))
        self.brush_value_label = tk.Label(brush_row, text=f"{self.brush_size}px", bg=COLOR_SIDEBAR, fg=COLOR_PRIMARY,
                                           font=_mkfont(FS_LABEL, "bold"), width=6, anchor="e")
        self.brush_value_label.pack(side=tk.RIGHT)
        tk.Label(brush_row, text="Kích thước cọ", bg=COLOR_SIDEBAR, fg=COLOR_TEXT_MAIN,
                 font=_mkfont(FS_LABEL)).pack(side=tk.LEFT)

        self.brush_var = tk.DoubleVar(value=self.brush_size)
        self.brush_scale = ttk.Scale(sec_tools.content, from_=MIN_BRUSH, to=MAX_BRUSH, orient=tk.HORIZONTAL,
                                      variable=self.brush_var, command=self.change_brush)
        self.brush_scale.pack(fill=tk.X, pady=(4, 4), ipady=2)

        row2 = tk.Frame(sec_tools.content, bg=COLOR_SIDEBAR)
        row2.pack(fill=tk.X, pady=(14, 6))
        styled_button(row2, "↶ UNDO", self.undo, kind="default").pack(side=tk.LEFT, fill=tk.X, expand=True, padx=(0, 5))
        styled_button(row2, "↷ REDO", self.redo, kind="default").pack(side=tk.LEFT, fill=tk.X, expand=True)

        # --- 6. Độ nét hiển thị (CHỈ preview, không ảnh hưởng file xuất) ---
        sec_sharp = SectionFrame(inner, "Độ nét hiển thị (Preview)")
        sec_sharp.pack(fill=tk.X, pady=(0, 18))

        sharp_row = tk.Frame(sec_sharp.content, bg=COLOR_SIDEBAR)
        sharp_row.pack(fill=tk.X, pady=(4, 2))
        self.sharpness_value_label = tk.Label(sharp_row, text="1.0x", bg=COLOR_SIDEBAR, fg=COLOR_PRIMARY,
                                               font=_mkfont(FS_LABEL, "bold"), width=5, anchor="e")
        self.sharpness_value_label.pack(side=tk.RIGHT)
        tk.Label(sharp_row, text="Độ nét", bg=COLOR_SIDEBAR, fg=COLOR_TEXT_MAIN,
                 font=_mkfont(FS_LABEL)).pack(side=tk.LEFT)

        self.sharpness_var = tk.DoubleVar(value=self.preview_sharpness)
        self.sharpness_scale = ttk.Scale(sec_sharp.content, from_=0.0, to=3.0, orient=tk.HORIZONTAL,
                                          variable=self.sharpness_var, command=self._on_sharpness_change)
        self.sharpness_scale.pack(fill=tk.X, pady=(4, 4), ipady=2)

        # Áp dụng bind cuộn chuột cho toàn bộ cây widget vừa dựng xong.
        _bind_wheel_recursive(inner)
        self._sidebar_bind_wheel_recursive = _bind_wheel_recursive  # lưu lại để gọi khi thêm widget động sau này
        self._sidebar_inner = inner

    def _refresh_tool_buttons(self):
        for key, btn in self.tool_buttons.items():
            btn.config(bg=COLOR_TOOL_ACTIVE if key == self.tool else "#F1F2F4")

    # ---------------- THANH TRẠNG THÁI DƯỚI (kiểu Word) ----------------
    def _build_statusbar(self, master):
        bar = tk.Frame(master, bg=COLOR_STATUSBAR, height=42, highlightthickness=1,
                        highlightbackground=COLOR_BORDER)
        bar.pack(side=tk.BOTTOM, fill=tk.X)
        bar.pack_propagate(False)

        # Trái: thông tin debug pixel
        self.pixel_info = tk.Label(
            bar, bg=COLOR_STATUSBAR, fg=COLOR_TEXT_SUB, font=_mkfont(FS_STATUSBAR, family=FONT_MONO), anchor="w",
            text="Pixel: —   |   RGB: —   |   Gốc: —",
        )
        self.pixel_info.pack(side=tk.LEFT, padx=16)

        # Phải: cụm zoom kiểu Word ( -  100%  + )
        zoom_cluster = tk.Frame(bar, bg=COLOR_STATUSBAR)
        zoom_cluster.pack(side=tk.RIGHT, padx=12)

        tk.Button(zoom_cluster, text="−", width=3, bd=0, bg=COLOR_STATUSBAR, fg=COLOR_TEXT_MAIN,
                  activebackground="#E4E6E9", font=_mkfont(15, "bold"), cursor="hand2",
                  command=self.zoom_out).pack(side=tk.LEFT)

        self.zoom_label = tk.Label(zoom_cluster, text=f"{DEFAULT_ZOOM * 100:.0f}%", bg=COLOR_STATUSBAR, fg=COLOR_TEXT_MAIN,
                                    font=_mkfont(FS_STATUSBAR, "bold"), width=6, anchor="center", cursor="hand2")
        self.zoom_label.pack(side=tk.LEFT, padx=3)
        self.zoom_label.bind("<Button-1>", lambda e: self.reset_zoom())

        tk.Button(zoom_cluster, text="+", width=3, bd=0, bg=COLOR_STATUSBAR, fg=COLOR_TEXT_MAIN,
                  activebackground="#E4E6E9", font=_mkfont(15, "bold"), cursor="hand2",
                  command=self.zoom_in).pack(side=tk.LEFT)

        # Nhãn "Trang i/n"
        self.page_indicator = tk.Label(bar, bg=COLOR_STATUSBAR, fg=COLOR_TEXT_MAIN,
                                        font=_mkfont(FS_STATUSBAR, "bold"), anchor="e",
                                        text="Trang —/—")
        self.page_indicator.pack(side=tk.RIGHT, padx=(12, 0))

        # Giữa: trạng thái tiến trình chung (đặt ở giữa, co giãn)
        self.status = tk.Label(bar, bg=COLOR_STATUSBAR, fg=COLOR_ACCENT_OK, font=_mkfont(FS_STATUSBAR), anchor="center",
                                text="Sẵn sàng")
        self.status.pack(side=tk.LEFT, fill=tk.X, expand=True)

    # ------------------------------------------------------------------
    # CHỌN FILE
    # ------------------------------------------------------------------
    def choose_a(self):
        path = filedialog.askopenfilename(title="Chọn PDF Input", filetypes=[("PDF", "*.pdf")])
        if not path: return
        try:
            with pymupdf.open(path) as doc:
                pages = len(doc)
                if pages == 0: raise ValueError("PDF Input không có trang.")
            self.pdf_a = path
            self.label_a.config(text=f"A: {os.path.basename(path)}  •  {pages} trang", fg=COLOR_PRIMARY)
            self._clear_previous_results()
            self.check_ready()
        except Exception as e:
            messagebox.showerror("Lỗi", str(e))

    def choose_b(self):
        path = filedialog.askopenfilename(title="Chọn PDF Compare", filetypes=[("PDF", "*.pdf")])
        if not path: return
        try:
            with pymupdf.open(path) as doc:
                pages = len(doc)
                if pages != 1: raise ValueError("PDF Compare phải có đúng 1 trang.")
            self.pdf_b = path
            self.label_b.config(text=f"B: {os.path.basename(path)}  •  mẫu watermark", fg=COLOR_ACCENT_AMB)
            self._clear_previous_results()
            self.check_ready()
        except Exception as e:
            messagebox.showerror("Lỗi", str(e))

    def _clear_previous_results(self):
        """Xoá sạch kết quả/preview của lần phân tích trước, đưa toàn bộ trạng thái
        về như lúc mới mở app"""
        if not self.result_pages and not self.original_pages:
            return
        self.result_pages = []
        self.original_pages = []
        self.page_sizes_pt = []
        self.removable_masks = []
        self.b_page_image = None
        self.current_page = 0
        self.undo_stack.clear()
        self.redo_stack.clear()
        self.zoom = DEFAULT_ZOOM
        self._page_layout = []
        self._render_cache.clear()
        self._page_rect_items.clear()
        self._page_image_items.clear()
        self._last_mouse_canvas_pos = None
        self._brush_cursor_id = None
        self.canvas.delete("all")
        self.zoom_label.config(text=f"{DEFAULT_ZOOM * 100:.0f}%")
        self.page_indicator.config(text="Trang —/—")
        self.pixel_info.config(text="Pixel: —   |   RGB: —   |   Gốc: —")
        self.status.config(text="Đã đổi file — nhấn Phân tích để xử lý lại.", fg=COLOR_TEXT_SUB)

    def check_ready(self):
        if self.pdf_a and self.pdf_b:
            self.analyze_button.config(state=tk.NORMAL)

    # ------------------------------------------------------------------
    # PHÂN TÍCH (chạy nền, KHÔNG đổi thuật toán)
    # ------------------------------------------------------------------
    def start_analysis(self):
        if self.processing: return
        try:
            lab_tol = float(self.lab_var.get())
            boost = float(self.boost_var.get())
        except Exception:
            messagebox.showerror("Lỗi", "Thông số không hợp lệ.")
            return

        self.processing = True
        self.analyze_button.config(state=tk.DISABLED)
        self.progress["value"] = 0
        self.status.config(text="Đang nội suy màu LAB, vui lòng chờ...", fg=COLOR_TEXT_SUB)
        threading.Thread(target=self.worker_analysis, args=(lab_tol, boost), daemon=True).start()

    def worker_analysis(self, lab_tol, boost):
        doc_a = doc_b = None
        try:
            doc_a = pymupdf.open(self.pdf_a)
            doc_b = pymupdf.open(self.pdf_b)
            b_image = render_page(doc_b[0])
            # B (watermark mẫu) không đổi giữa các trang -> chuyển sang LAB một lần duy nhất
            # ở đây, thay vì tính lại trong process_watermark_advanced mỗi trang.
            lab_b_full = cv2.cvtColor(b_image, cv2.COLOR_RGB2LAB).astype(np.float32)

            a_images, originals, masks, page_sizes_pt = [], [], [], []
            total_pages = len(doc_a)

            for i, page in enumerate(doc_a):
                self.root.after(0, self.status.config, {"text": f"Đang tách lớp watermark trang ({i + 1}/{total_pages})..."})
                a = render_page(page)
                # Lưu kích thước trang gốc (points) ngay lúc còn mở doc_a, để export_pdf
                # dùng lại sau này thay vì phải mở lại file gốc từ đường dẫn.
                rect = page.rect
                page_sizes_pt.append((rect.width, rect.height))

                # Gọi Lõi Thuật Toán Hoàn Hảo (không đổi)
                result, mask = process_watermark_advanced(a, b_image, lab_b_full, lab_tol, boost)

                originals.append(a)
                a_images.append(result)
                masks.append(mask)

                percent = (i + 1) / total_pages * 100
                self.root.after(0, self.progress.config, {"value": percent})

            self.root.after(0, self.analysis_finished, a_images, originals, masks, b_image, page_sizes_pt)
        except Exception as e:
            self.root.after(0, self.analysis_failed, str(e))
        finally:
            if doc_a: doc_a.close()
            if doc_b: doc_b.close()

    def analysis_finished(self, results, originals, masks, b_image, page_sizes_pt):
        self.result_pages = results
        self.original_pages = originals
        self.removable_masks = masks
        self.b_page_image = b_image
        self.page_sizes_pt = page_sizes_pt
        self.current_page = 0
        self.undo_stack.clear()
        self.redo_stack.clear()
        self.processing = False
        self.analyze_button.config(state=tk.NORMAL)
        self.status.config(text="Hoàn tất!", fg=COLOR_ACCENT_OK)
        self.reset_zoom()
        self.render_all_pages()
        # current_page=0 chỉ là biến trạng thái; phải chủ động cuộn canvas về
        # đỉnh để người dùng THỰC SỰ thấy Trang 1 đầu tiên (nếu trước đó đang
        # cuộn dở ở giữa tài liệu cũ, vị trí cuộn không tự reset theo biến số).
        self.canvas.yview_moveto(0.0)
        self._update_page_indicator()

    def analysis_failed(self, error):
        self.processing = False
        self.analyze_button.config(state=tk.NORMAL)
        self.status.config(text="Lỗi trong quá trình xử lý.", fg="#DC2626")
        messagebox.showerror("Lỗi", error)

    # ------------------------------------------------------------------
    # PREVIEW DẠNG CUỘN ẢO
    # ------------------------------------------------------------------
    #   1) Tính TRƯỚC vị trí/kích thước của MỌI trang — thao tác rẻ (chỉ đọc
    #      .shape, không render ảnh) — để scrollbar/scrollregion luôn chính xác
    #      ngay cả với tài liệu rất nhiều trang.
    #   2) Vẽ khung "tờ giấy" (placeholder) cho mọi trang ngay từ đầu — rẻ, giúp
    #      cuộn mượt không bị giật do thiếu bố cục.
    #   3) CHỈ render ảnh (PhotoImage, tốn CPU/RAM) cho các trang đang thực sự
    #      nằm trong vùng nhìn thấy (+ vài trang đệm), thông qua sự kiện cuộn.
    #   4) Ảnh đã render được giữ trong cache LRU giới hạn số lượng — cuộn qua
    #      lại trong vùng gần không phải render lại; cuộn xa mới giải phóng và
    #      render lại. Đây là phần đóng vai trò "tái sử dụng" tương đương với
    #      việc Google Docs tái chế canvas.
    def render_all_pages(self):
        if not self.result_pages:
            self.canvas.delete("all")
            self.page_indicator.config(text="Trang —/—")
            return
        self._rebuild_layout()
        self._update_visible_pages(force=True)

    # Tương thích ngược với các chỗ khác trong code còn gọi show_preview()
    def show_preview(self):
        self.render_all_pages()

    def _rebuild_layout(self):
        """Tính vị trí (offset_y, x_left, disp_w, disp_h) cho MỌI trang theo
        zoom hiện tại"""
        self.canvas.delete("all")
        self._page_rect_items.clear()
        self._page_image_items.clear()
        self._render_cache.clear()  # zoom đổi -> cache ảnh cũ không còn dùng được, xóa hết
        self._brush_cursor_id = None  # item cũ (nếu có) đã bị xoá bởi delete("all") ở trên

        max_width = max(img.shape[1] for img in self.result_pages)
        cursor_y = PAGE_GAP
        layout = []
        for image in self.result_pages:
            h, w = image.shape[:2]
            disp_w = max(1, int(w * self.zoom))
            disp_h = max(1, int(h * self.zoom))
            x_center = int(max_width * self.zoom / 2)
            x_left = x_center - disp_w // 2
            layout.append((cursor_y, x_left, disp_w, disp_h))
            cursor_y += disp_h + PAGE_GAP
        self._page_layout = layout
        self._layout_zoom = self.zoom

        total_h = cursor_y
        total_w = int(max_width * self.zoom) + PAGE_GAP * 4
        self.canvas.configure(scrollregion=(0, 0, total_w, total_h))

        # Vẽ khung "tờ giấy" cho mọi trang ngay (rẻ: chỉ là 1 rectangle mỗi trang)
        for idx, (off_y, x_left, disp_w, disp_h) in enumerate(layout):
            rect_id = self.canvas.create_rectangle(
                x_left - 2, off_y - 2, x_left + disp_w + 2, off_y + disp_h + 2,
                fill="#FAFAFA", outline=COLOR_BORDER, tags=("page_frame", f"page_{idx}"),
            )
            self._page_rect_items[idx] = rect_id

        self.zoom_label.config(text=f"{self.zoom * 100:.0f}%")

    def _visible_page_range(self):
        """Trả về (first_idx, last_idx) các trang đang nằm trong vùng nhìn
        thấy của canvas hiện tại"""
        if not self._page_layout:
            return None
        top = self.canvas.canvasy(0)
        bottom = self.canvas.canvasy(self.canvas.winfo_height())
        first, last = None, None
        for idx, (off_y, _, _, disp_h) in enumerate(self._page_layout):
            if off_y + disp_h >= top and off_y <= bottom:
                if first is None:
                    first = idx
                last = idx
        if first is None:
            # Canvas chưa có kích thước thật (vd. lần vẽ đầu tiên trước khi
            # winfo_height() ổn định) -> tạm hiển thị vài trang đầu để không trắng trơn.
            return 0, min(len(self._page_layout) - 1, VIEWPORT_BUFFER_PAGES * 2)
        first = max(0, first - VIEWPORT_BUFFER_PAGES)
        last = min(len(self._page_layout) - 1, last + VIEWPORT_BUFFER_PAGES)
        return first, last

    def _get_or_render_photo(self, idx):
        """Lấy PhotoImage của trang idx từ cache LRU"""
        key = idx
        if key in self._render_cache:
            self._render_cache.move_to_end(key)  # đánh dấu vừa dùng
            return self._render_cache[key]

        image = self.result_pages[idx]
        _, _, disp_w, disp_h = self._page_layout[idx]
        pil_img = np_to_pil(image).resize((disp_w, disp_h), Image.Resampling.NEAREST)
        # Chỉnh độ nét CHỈ cho bản hiển thị
        if abs(self.preview_sharpness - 1.0) > 1e-3:
            pil_img = ImageEnhance.Sharpness(pil_img).enhance(self.preview_sharpness)
        photo = ImageTk.PhotoImage(pil_img)

        self._render_cache[key] = photo
        self._render_cache.move_to_end(key)
        while len(self._render_cache) > RENDER_CACHE_MAX_PAGES:
            old_idx, _ = self._render_cache.popitem(last=False)  # loại phần tử cũ nhất
            if old_idx in self._page_image_items:
                self.canvas.delete(self._page_image_items.pop(old_idx))
        return photo

    def _update_visible_pages(self, force=False):
        if not self._page_layout:
            return
        rng = self._visible_page_range()
        if rng is None:
            return
        first, last = rng
        wanted = set(range(first, last + 1))

        # Gỡ ảnh của các trang vừa rơi ra khỏi viewport (giữ khung giấy lại, chỉ bỏ ảnh)
        for idx in list(self._page_image_items.keys()):
            if idx not in wanted:
                self.canvas.delete(self._page_image_items.pop(idx))

        # Vẽ ảnh cho các trang trong viewport chưa có ảnh trên canvas
        for idx in wanted:
            if idx in self._page_image_items and not force:
                continue
            if idx in self._page_image_items and force:
                self.canvas.delete(self._page_image_items.pop(idx))
            photo = self._get_or_render_photo(idx)
            off_y, x_left, disp_w, disp_h = self._page_layout[idx]
            img_id = self.canvas.create_image(x_left, off_y, image=photo, anchor=tk.NW,
                                               tags=(f"page_{idx}",))
            self._page_image_items[idx] = img_id
            # Ảnh phải nằm TRÊN khung giấy của chính nó
            self.canvas.tag_raise(img_id, self._page_rect_items[idx])

        self._update_page_indicator()

    def _update_page_indicator(self):
        """Cập nhật nhãn 'Trang i/n' ở statusbar"""
        if not self._page_layout:
            return
        top = self.canvas.canvasy(0)
        current = 0
        for idx, (off_y, _, _, disp_h) in enumerate(self._page_layout):
            # Trang được coi là "đang xem" nếu đỉnh viewport đã đi qua điểm giữa
            # của nó trở lên -> tránh nhảy số quá sớm khi trang mới chỉ vừa hé ra.
            if top >= off_y - disp_h / 2:
                current = idx
        self.page_indicator.config(text=f"Trang {current + 1}/{len(self._page_layout)}")

    def on_canvas_scroll_or_resize(self, event=None):
        """Debounce: nhiều sự kiện cuộn/resize"""
        if self._scroll_job is not None:
            self.root.after_cancel(self._scroll_job)
        self._scroll_job = self.root.after(30, self._update_visible_pages)

    def _locate_page_at(self, canvas_x, canvas_y):
        """Tìm trang chứa điểm canvas (đã cộng scroll) và trả về
        (page_index, pixel_x_trong_anh, pixel_y_trong_anh) hoặc None."""
        for idx, (off_y, x_left, disp_w, disp_h) in enumerate(self._page_layout):
            if off_y <= canvas_y <= off_y + disp_h and x_left <= canvas_x <= x_left + disp_w:
                px = int((canvas_x - x_left) / self.zoom)
                py = int((canvas_y - off_y) / self.zoom)
                h, w = self.result_pages[idx].shape[:2]
                if 0 <= px < w and 0 <= py < h:
                    return idx, px, py
        return None

    def canvas_to_pixel(self, event):
        """ trả về (x, y) trong ẢNH CỦA TRANG ĐANG ĐƯỢC TRỎ TỚI, đồng thời cập nhật self.current_page."""
        if not self.result_pages: return None
        canvas_x = self.canvas.canvasx(event.x)
        canvas_y = self.canvas.canvasy(event.y)
        found = self._locate_page_at(canvas_x, canvas_y)
        if not found:
            return None
        idx, px, py = found
        self.current_page = idx
        return px, py

    def on_mousewheel_scroll(self, event):
        if not self.result_pages:
            return
        delta = event.delta if hasattr(event, "delta") and event.delta else (120 if getattr(event, "num", 5) == 4 else -120)
        self.canvas.yview_scroll(-1 if delta > 0 else 1, "units")
        self.on_canvas_scroll_or_resize()

    def on_mouse_move(self, event):
        pos = self.canvas_to_pixel(event)
        if pos: self.show_pixel_info(*pos)
        self._update_brush_cursor(event)

    def on_canvas_leave(self, event):
        """Chuột rời khỏi khu preview -> xoá khung viền đỏ xem trước cọ tẩy"""
        self._last_mouse_canvas_pos = None
        if getattr(self, "_brush_cursor_id", None) is not None:
            self.canvas.delete(self._brush_cursor_id)
            self._brush_cursor_id = None

    def _update_brush_cursor(self, event):
        canvas_x = self.canvas.canvasx(event.x)
        canvas_y = self.canvas.canvasy(event.y)
        self._last_mouse_canvas_pos = (canvas_x, canvas_y)
        self._draw_brush_cursor_at(canvas_x, canvas_y)

    def _refresh_brush_cursor_size(self):
        """Vẽ lại viền đỏ ở ĐÚNG vị trí con trỏ đã ghi nhận lần cuối"""
        pos = getattr(self, "_last_mouse_canvas_pos", None)
        if pos is None:
            return
        self._draw_brush_cursor_at(*pos)

    def _draw_brush_cursor_at(self, canvas_x, canvas_y):
        """Vẽ khung viền đỏ theo đúng vị trí + kích thước cọ hiện tại tại toạ
        độ canvas đã cho"""
        # Xoá overlay cũ trước, vẽ lại nếu còn hợp lệ
        if getattr(self, "_brush_cursor_id", None) is not None:
            self.canvas.delete(self._brush_cursor_id)
            self._brush_cursor_id = None

        if self.tool != "eraser" or not self.result_pages:
            return

        # Chỉ hiện viền khi con trỏ thực sự đang ở trên một trang
        if self._locate_page_at(canvas_x, canvas_y) is None:
            return

        # Kích thước cọ (self.brush_size) tính theo pixel-ảnh gốc
        half = max(1, self.brush_size) / 2 * self.zoom
        self._brush_cursor_id = self.canvas.create_rectangle(
            canvas_x - half, canvas_y - half, canvas_x + half, canvas_y + half,
            outline="#FF0000", width=2, tags=("brush_cursor",),
        )
        self.canvas.tag_raise(self._brush_cursor_id)

    def show_pixel_info(self, x, y):
        if not self.result_pages: return
        result = self.result_pages[self.current_page]
        original = self.original_pages[self.current_page]
        rgb = tuple(int(v) for v in result[y, x])
        rgb_a = tuple(int(v) for v in original[y, x])
        self.pixel_info.config(text=(
            f"Pixel: ({x}, {y})   |   RGB: {rgb}   |   Gốc: {rgb_a}"
        ))

    # ------------------------------------------------------------------
    # CÔNG CỤ THỦ CÔNG 
    # ------------------------------------------------------------------
    def set_tool(self, tool):
        self.tool = tool
        self._refresh_tool_buttons()
        self.status.config(text=f"Công cụ đang chọn: {tool}", fg=COLOR_TEXT_SUB)
        if tool != "eraser":
            if getattr(self, "_brush_cursor_id", None) is not None:
                self.canvas.delete(self._brush_cursor_id)
                self._brush_cursor_id = None
        else:
            self._refresh_brush_cursor_size()

    def change_brush(self, value=None):
        """Callback của thanh trượt (ttk.Scale) kích thước cọ"""
        try:
            size = max(MIN_BRUSH, min(MAX_BRUSH, int(round(float(self.brush_var.get())))))
        except Exception:
            return
        self.brush_size = size
        self.brush_value_label.config(text=f"{size}px")
        self._refresh_brush_cursor_size()

    def _on_sharpness_change(self, _value=None):
        """debounce chỉ render lại ~50ms sau khi người dùng dừng kéo."""
        self.sharpness_value_label.config(text=f"{self.sharpness_var.get():.1f}x")
        if getattr(self, "_sharpness_job", None) is not None:
            self.root.after_cancel(self._sharpness_job)
        self._sharpness_job = self.root.after(50, self._apply_sharpness_now)

    def _apply_sharpness_now(self):
        self.preview_sharpness = float(self.sharpness_var.get())
        if not self._page_layout:
            return
        self._render_cache.clear()
        self._update_visible_pages(force=True)

    def save_undo_state(self):
        if not self.result_pages: return
        self.undo_stack.append((self.current_page, self.result_pages[self.current_page].copy()))
        if len(self.undo_stack) > UNDO_LIMIT:
            self.undo_stack.pop(0)
        self.redo_stack.clear()

    def on_mouse_down(self, event):
        pos = self.canvas_to_pixel(event)
        if not pos: return
        x, y = pos
        if self.tool == "eyedropper":
            image = self.result_pages[self.current_page]
            self.paint_color = tuple(int(v) for v in image[y, x])
            self.status.config(text=f"Đã hút màu RGB={self.paint_color}", fg=COLOR_TEXT_SUB)
            return
        if self.tool in ("pencil", "eraser"):
            self.save_undo_state()
            self.paint_at(x, y)

    def on_mouse_drag(self, event):
        self._update_brush_cursor(event)
        if self.tool not in ("pencil", "eraser"): return
        pos = self.canvas_to_pixel(event)
        if pos: self.paint_at(*pos)

    def on_mouse_up(self, event):
        self._invalidate_page(self.current_page)

    def _invalidate_page(self, idx):
        """Xóa ảnh đã cache/hiển thị của MỘT trang rồi vẽ lại ngay nếu trang đó đang trong viewport"""
        if not self._page_layout or idx is None or idx >= len(self._page_layout):
            return
        self._render_cache.pop(idx, None)
        if idx in self._page_image_items:
            self.canvas.delete(self._page_image_items.pop(idx))
        self._update_visible_pages(force=False)

    def paint_at(self, cx, cy):
        if not self.result_pages: return
        image = self.result_pages[self.current_page]
        h, w = image.shape[:2]
        size = max(1, self.brush_size)
        half = size // 2
        x0, x1 = max(0, cx - half), min(w, cx + half + 1)
        y0, y1 = max(0, cy - half), min(h, cy + half + 1)
        if self.tool == "eraser":
            paper = detect_paper_color(self.original_pages[self.current_page]).astype(np.uint8)
            image[y0:y1, x0:x1] = paper
        elif self.tool == "pencil":
            image[y0:y1, x0:x1] = self.paint_color
        self._invalidate_page(self.current_page)

    def undo(self):
        if not self.undo_stack: return
        page, state = self.undo_stack.pop()
        self.redo_stack.append((page, self.result_pages[page].copy()))
        self.result_pages[page] = state
        self.current_page = page
        self._invalidate_page(page)

    def redo(self):
        if not self.redo_stack: return
        page, state = self.redo_stack.pop()
        self.undo_stack.append((page, self.result_pages[page].copy()))
        self.result_pages[page] = state
        self.current_page = page
        self._invalidate_page(page)

    # ------------------------------------------------------------------
    # ZOOM
    # ------------------------------------------------------------------
    def zoom_in(self):
        if not self.result_pages: return
        self.zoom = min(MAX_ZOOM, self.zoom * ZOOM_STEP)
        self.render_all_pages()

    def zoom_out(self):
        if not self.result_pages: return
        self.zoom = max(MIN_ZOOM, self.zoom / ZOOM_STEP)
        self.render_all_pages()

    def reset_zoom(self):
        self.zoom = DEFAULT_ZOOM
        if self.result_pages:
            self.render_all_pages()
        else:
            self.zoom_label.config(text=f"{DEFAULT_ZOOM * 100:.0f}%")

    def mouse_zoom(self, event):
        if event.delta > 0: self.zoom_in()
        else: self.zoom_out()

    # ------------------------------------------------------------------
    # XUẤT FILE
    # ------------------------------------------------------------------
    def _default_export_basename(self):
        """Tên gốc dùng chung cho cả xuất PDF và xuất PNG"""
        if self.pdf_a:
            base_name = os.path.splitext(os.path.basename(self.pdf_a))[0]
            return f"{base_name} (RW)"
        return "result (RW)"

    def export_png(self):
        if not self.result_pages: return
        parent_folder = filedialog.askdirectory(title="Chọn nơi lưu")
        if not parent_folder: return
        try:
            export_folder = os.path.join(parent_folder, self._default_export_basename())
            os.makedirs(export_folder, exist_ok=True)
            for i, image in enumerate(self.result_pages):
                path = os.path.join(export_folder, f"page_{i + 1:04d}.png")
                np_to_pil(image).save(path, format="PNG", pnginfo=PngInfo())
            messagebox.showinfo("Hoàn tất", f"Đã xuất {len(self.result_pages)} trang vào:\n{export_folder}")
        except Exception as e: messagebox.showerror("Lỗi", str(e))

    def export_pdf(self):
        if not self.result_pages: return
        default_name = f"{self._default_export_basename()}.pdf"
        path = filedialog.asksaveasfilename(title="Xuất PDF", defaultextension=".pdf", initialfile=default_name, filetypes=[("PDF", "*.pdf")])
        if not path: return
        try:
            same_count = len(self.page_sizes_pt) == len(self.result_pages)
            output = pymupdf.open()
            for i, image in enumerate(self.result_pages):
                if same_count:
                    width_pt, height_pt = self.page_sizes_pt[i]
                else:
                    h_px, w_px = image.shape[:2]
                    width_pt = w_px / INTERNAL_SCALE
                    height_pt = h_px / INTERNAL_SCALE
                image_to_pdf_page(output, image, width_pt, height_pt)

            # --- Xóa metadata ---
            output.set_metadata({})
            output.del_xml_metadata()

            # --- Tuyến tính hóa ---
            output.save(path, garbage=4, deflate=True, use_objstms=True)
            output.close()
            messagebox.showinfo("Hoàn tất", f"Đã lưu tại:\n{path}")
        except Exception as e: messagebox.showerror("Lỗi", str(e))

if __name__ == "__main__":
    root = tk.Tk()
    App(root)
    root.mainloop()

# Nếu đã đọc đến đây thì hãy nhớ rằng AN là một con chó