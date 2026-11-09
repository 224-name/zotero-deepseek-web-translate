"""检查 core.js 生成的 docx 能否被 python-docx 正常打开与读取。"""
import sys
from docx import Document
from docx.shared import Pt

path = sys.argv[1]
doc = Document(path)

print("paragraphs:", len(doc.paragraphs))
print("sections  :", len(doc.sections))
sec = doc.sections[0]
print("page size : %.1f x %.1f mm" % (sec.page_width.mm, sec.page_height.mm))
print("margins   : %.1f / %.1f mm" % (sec.left_margin.mm, sec.top_margin.mm))
print("-" * 70)
for i, p in enumerate(doc.paragraphs):
    text = p.text.replace("\n", "\\n")
    if len(text) > 74:
        text = text[:74] + "…"
    fonts = set()
    for r in p.runs:
        rf = r._element.rPr.rFonts if r._element.rPr is not None else None
        if rf is not None:
            fonts.add(rf.get("{http://schemas.openxmlformats.org/wordprocessingml/2006/main}eastAsia"))
    print("%2d [%-11s] %s" % (i, p.style.style_id, text))
print("-" * 70)
print("styles used:", sorted({p.style.style_id for p in doc.paragraphs}))
assert len(doc.paragraphs) >= 8, "段落数异常"
assert all(len(p.text) >= 0 for p in doc.paragraphs)
assert "双语对照样例" in doc.paragraphs[0].text, "标题读取失败"
print("OK: docx 结构可被 python-docx 正确解析")
