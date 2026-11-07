"""仅开发实验：原图/局部对比度/放大/二值化对照；不作为BGI运行依赖。"""
import json
import re
import time
import hashlib
import subprocess
from pathlib import Path
import cv2
import numpy as np
from PIL import Image
from rapidocr_onnxruntime import RapidOCR

root = Path(__file__).resolve().parent.parent
file = root / 'reference-images/自定义名称-旅行者冰.png'
regions = json.loads(subprocess.check_output(['node', '--input-type=module', '-e',
    "import {ACCOUNT_REGIONS as r} from './utils/account-reader.js'; console.log(JSON.stringify(['header','menu','characterName','characterLevel','biography','uid'].map(field=>({field,region:r[field]}))))"], cwd=root, text=True, encoding='utf-8'))
image = np.array(Image.open(file).convert('RGB'))[:, :, ::-1].copy()
engine = RapidOCR()
clahe = cv2.createCLAHE(clipLimit=2, tileGridSize=(8, 8))
expected = dict(header='冰元素/示例', characterName='示例', biography=json.loads(
    (root / 'assets/custom-character-descriptions.json').read_text(encoding='utf-8'))['descriptions']['traveler'])
def distance(a, b):
    row = list(range(len(b)+1))
    for i, char in enumerate(a):
        next_row = [i+1]
        for j, other in enumerate(b):
            next_row.append(min(next_row[-1]+1, row[j+1]+1, row[j]+(char!=other)))
        row = next_row
    return row[-1]
def characters(text):
    return re.sub(r'[^\u4e00-\u9fff0-9]', '', text)
methods = []
for method in ['original', 'clahe', 'scale2', 'otsu']:
    items, results = [], []
    for target in regions:
        field = target['field']
        if method != 'original' and field not in expected:
            continue
        x, y, width, height = target['region']
        crop = image[y:y+height, x:x+width]
        started = time.perf_counter()
        scale = 1
        if method == 'clahe':
            crop = clahe.apply(cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY))
        elif method == 'scale2':
            crop = cv2.resize(crop, None, fx=2, fy=2, interpolation=cv2.INTER_CUBIC)
            scale = 2
        elif method == 'otsu':
            _, crop = cv2.threshold(cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY), 0, 255, cv2.THRESH_BINARY+cv2.THRESH_OTSU)
        preprocess_ms = (time.perf_counter()-started)*1000
        ocr_started = time.perf_counter()
        result, _ = engine(crop, use_cls=False)
        ocr_ms = (time.perf_counter()-ocr_started)*1000
        text = ''.join(row[1] for row in result or [])
        if field in expected:
            left, right = characters(text), characters(expected[field])
            results.append(dict(field=field, text=text, editDistance=distance(left,right), expectedLength=len(right),
                                preprocessMs=round(preprocess_ms,3), ocrMs=round(ocr_ms,1)))
        for box, text, confidence in result or []:
            left, top = min(p[0] for p in box)/scale, min(p[1] for p in box)/scale
            right, bottom = max(p[0] for p in box)/scale, max(p[1] for p in box)/scale
            items.append(dict(text=text, x=x+left, y=y+top, width=right-left, height=bottom-top,
                              confidence=float(confidence), ocrField=field))
    methods.append(dict(method=method, results=results, items=items))
    print(json.dumps(dict(method=method,results=results),ensure_ascii=True),flush=True)
output = dict(source='Actual RapidOCR experiment, 2026-10-26; not BGI engine benchmark',
              file='reference-images/自定义名称-旅行者冰.png', sha256=hashlib.sha256(file.read_bytes()).hexdigest(), methods=methods)
(root / 'tools/fixtures/traveler-ocr-comparison.json').write_text(json.dumps(output,ensure_ascii=False,indent=2),encoding='utf-8')
