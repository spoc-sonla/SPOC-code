from selenium.webdriver.common.by import By
from selenium.webdriver.common.keys import Keys
from selenium import webdriver
from selenium.webdriver.chrome.options import Options
import json
from time import sleep

app_state = {
    "recentDestinations": [{"id": "Save as PDF", "origin": "local", "account": ""}],
    "selectedDestinationId": "Save as PDF",
    "version": 2,
    "isHeaderFooterEnabled": False,
    "mediaSize": {
        "name": "ISO_A4",
        "width_microns": 210000,
        "height_microns": 297000
    },
    "marginsType": 1,
    "scalingType": 3,
    "scaling": "100",
    "isCssBackgroundEnabled": False
}

def convert_scribd_link(url):
    import re
    match = re.search(r'https://www\.scribd\.com/document/(\d+)/', url)
    if match:
        doc_id = match.group(1)
        return f'https://www.scribd.com/embeds/{doc_id}/content'
    return "Invalid Scribd URL"

options = Options()
options.add_experimental_option("detach", True)
options.add_argument("--devtools")
options.add_experimental_option(
    "prefs",
    {
        "printing.print_preview_sticky_settings.appState": json.dumps(app_state),
        "download.prompt_for_download": True,
        "savefile.prompt_for_download": True,
    }
)

input_url = input("Input link Scribd: ")
converted_url = convert_scribd_link(input_url)
print("Link embed:", converted_url)

# ============================================================
# CHỌN CHẾ ĐỘ: "scroll" = cuộn dọc | "slide" = sang ngang
MODE = "scroll"
# ============================================================

# Chỉ cần điền số trang nếu dùng MODE = "slide"
TOTAL_PAGES = 216

driver = webdriver.Chrome(options=options)
driver.get(converted_url)
sleep(3)

# ── CHẾ ĐỘ CUỘN DỌC ──────────────────────────────────────
if MODE == "scroll":
    page_elements = driver.find_elements("css selector", "[class*='page']")
    for page in page_elements:
        driver.execute_script("arguments[0].scrollIntoView();", page)
        sleep(1)
    print(f"Đã cuộn qua {len(page_elements)} trang")

# ── CHẾ ĐỘ SANG NGANG ────────────────────────────────────
elif MODE == "slide":
    for i in range(1, TOTAL_PAGES):
        try:
            next_btn = driver.find_element(By.CSS_SELECTOR,
                "[class*='next'], [class*='arrow_right'], "
                "[class*='right_arrow'], [aria-label='Next page']")
            next_btn.click()
        except:
            driver.find_element(By.TAG_NAME, "body").send_keys(Keys.ARROW_RIGHT)
        sleep(1)
    print(f"Đã duyệt hết {TOTAL_PAGES} trang")

# ── XỬ LÝ CHUNG SAU KHI DUYỆT XONG ──────────────────────
sleep(2)
driver.execute_script("""
    ['toolbar_top', 'toolbar_bottom'].forEach(cls => {
        var el = document.querySelector('.' + cls);
        if (el) el.parentNode.removeChild(el);
    });
""")

for element in driver.find_elements(By.CLASS_NAME, "document_scroller"):
    driver.execute_script("arguments[0].setAttribute('class', '');", element)

sleep(2)
driver.execute_script("setTimeout(window.print, 1000)")
